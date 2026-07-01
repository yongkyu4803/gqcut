/**
 * 내보내기 스파이크 (1.5) — 타임라인을 프레임별로 오프스크린 렌더 → FFmpeg stdin 파이프.
 * 프리뷰와 동일한 컴포지터/장면 빌더 사용 (WYSIWYG).
 *
 * 렌더 실행 위치 결정(1.5.1): 보이는 렌더러 프로세스의 OffscreenCanvas 에서 렌더.
 * 근거: 프리뷰와 완전히 동일한 GL 환경 → WYSIWYG 보장이 최우선. 내보내기 중 편집은 잠근다.
 * 측정 결과 IPC 처리량이 병목이면 숨김 BrowserWindow + YUV 전송으로 이전 (ARCHITECTURE §6.1~6.2).
 */
import type { Project } from '@shared/model/types'
import type { ExportResult, ExportStartOptions } from '@shared/ipc-types'
import { frameCount } from '@shared/time'
import { Compositor } from './compositor'
import { buildLayersAccurate } from './scene'
import { projectDuration } from '@renderer/state/commands'

export interface ExportHandle {
  promise: Promise<ExportResult>
  cancel(): void
}

/** 오디오 패스스루 세그먼트 생성 (1.5.4): 첫 번째 비디오 트랙 기준, 갭은 무음 */
function buildAudioSegments(project: Project, durationSec: number): ExportStartOptions['audioSegments'] {
  const track = project.tracks.find((t) => t.kind === 'video' && t.clips.some((c) => c.kind === 'video'))
  const segs: ExportStartOptions['audioSegments'] = []
  let cursor = 0
  if (track) {
    const clips = [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart)
    for (const clip of clips) {
      if (clip.timelineStart > cursor + 1e-6) segs.push({ silenceSec: clip.timelineStart - cursor })
      const asset = clip.assetId ? project.assets.find((a) => a.id === clip.assetId) : undefined
      const speed = clip.speed ?? 1
      // 스파이크 범위: 등속(1.0) 클립만 패스스루, 그 외는 무음 (믹스다운은 Phase 5)
      if (asset?.audioWavPath && Math.abs(speed - 1) < 1e-6 && clip.sourceIn !== undefined && clip.sourceOut !== undefined) {
        segs.push({ wavPath: asset.audioWavPath, sourceIn: clip.sourceIn, sourceOut: clip.sourceOut })
      } else {
        segs.push({ silenceSec: clip.timelineEnd - clip.timelineStart })
      }
      cursor = clip.timelineEnd
    }
  }
  if (cursor < durationSec - 1e-6) segs.push({ silenceSec: durationSec - cursor })
  return segs
}

export function exportTimeline(
  project: Project,
  outputPath: string,
  onProgress: (percent: number) => void
): ExportHandle {
  let cancelled = false
  let jobIdForCancel: string | null = null

  const promise = (async (): Promise<ExportResult> => {
    const { width, height, fps, sampleRate, backgroundColor } = project.settings
    const durationSec = projectDuration(project)
    const totalFrames = frameCount(durationSec, fps)
    if (totalFrames === 0) return { ok: false, error: '타임라인이 비어 있습니다' }

    const { jobId } = await window.editor.exportStart({
      outputPath,
      width,
      height,
      fps,
      sampleRate,
      audioSegments: buildAudioSegments(project, durationSec),
      vflip: true // WebGL readPixels 는 bottom-up
    })
    jobIdForCancel = jobId

    // 오프스크린 컴포지터 — 프리뷰와 동일 셰이더/규칙
    const offscreen = new OffscreenCanvas(width, height)
    const compositor = new Compositor(offscreen, width, height)

    try {
      const t0 = performance.now()
      for (let fi = 0; fi < totalFrames; fi++) {
        if (cancelled) {
          await window.editor.exportCancel(jobId)
          return { ok: false, error: 'cancelled' }
        }
        // 프레임 중앙 시각 샘플링 — 경계 반올림에 의한 프레임 귀속 오류 방지
        const t = (fi + 0.5) / fps
        const layers = await buildLayersAccurate(project, t)
        compositor.render(layers, backgroundColor)
        const pixels = compositor.readPixels()
        // IPC 는 구조 복제 — 내부 버퍼 재사용을 위해 복사본 전송
        await window.editor.exportFrame(jobId, pixels.slice().buffer)
        if (fi % 5 === 0 || fi === totalFrames - 1) onProgress(((fi + 1) / totalFrames) * 100)
      }
      const result = await window.editor.exportFinish(jobId)
      if (result.ok && result.stats) {
        const wallSec = (performance.now() - t0) / 1000
        // 처리량 기록 (1.5.3) — 콘솔 + 결과에 포함
         
        console.info(
          `[export] ${result.stats.frames}프레임 / ${wallSec.toFixed(1)}s (x${(durationSec / wallSec).toFixed(2)} 실시간), ` +
            `파이프 ${result.stats.mbPerSec.toFixed(0)}MB/s`
        )
      }
      return result
    } catch (e) {
      await window.editor.exportCancel(jobId).catch(() => {})
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      compositor.dispose()
    }
  })()

  return {
    promise,
    cancel: () => {
      cancelled = true
      if (jobIdForCancel) void window.editor.exportCancel(jobIdForCancel)
    }
  }
}
