/**
 * 내보내기 엔진 (5.2) — 타임라인 전체(컷/이펙트/텍스트/전환/오디오 믹스다운)를 인코딩.
 * 프리뷰와 동일한 컴포지터/장면 빌더/오디오 그래프 사용 (WYSIWYG).
 *
 * 렌더 실행 위치 (1.5.1 확정): 보이는 렌더러의 OffscreenCanvas — 프리뷰와 동일 GL 환경.
 * 오디오 (5.1.2 확정): OfflineAudioContext 믹스다운 → f32le 스트리밍 → FFmpeg mux.
 */
import type { Project } from '@shared/model/types'
import type { ExportResult } from '@shared/ipc-types'
import { frameCount } from '@shared/time'
import { Compositor } from './compositor'
import { buildSceneAccurate } from './scene'
import { interleaveStereo, renderMixdown } from './audioEngine'
import { playback } from './playback'
import { projectDuration } from '@renderer/state/commands'
import { collectSfxTriggers } from '@shared/sfx'

export interface ExportSettings {
  /** 출력 해상도: 프로젝트 그대로 or 프리셋 */
  resolution: 'source' | '1080p' | '720p'
  /** libx264 CRF 프리셋 (5.2.4) — 초기 H.264+AAC/MP4 한정 */
  quality: 'high' | 'standard' | 'compact'
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = { resolution: 'source', quality: 'high' }

const CRF: Record<ExportSettings['quality'], number> = { high: 18, standard: 21, compact: 25 }

function presetScale(project: Project, resolution: ExportSettings['resolution']): { w?: number; h?: number } {
  const { width, height } = project.settings
  const targetH = resolution === '1080p' ? 1080 : resolution === '720p' ? 720 : null
  if (!targetH || targetH >= height) return {}
  const w = Math.round((width / height) * targetH * 0.5) * 2 // 짝수 강제
  return { w, h: targetH }
}

function hasAnyAudio(project: Project): boolean {
  for (const track of project.tracks) {
    if (track.kind === 'text') continue
    for (const clip of track.clips) {
      const asset = clip.assetId ? project.assets.find((a) => a.id === clip.assetId) : undefined
      if (asset?.audioWavPath) return true
    }
  }
  return false
}

export interface ExportHandle {
  promise: Promise<ExportResult>
  cancel(): void
}

const AUDIO_CHUNK_BYTES = 4 * 1024 * 1024

export function exportTimeline(
  project: Project,
  outputPath: string,
  settings: ExportSettings,
  onProgress: (percent: number) => void
): ExportHandle {
  let cancelled = false
  let jobIdForCancel: string | null = null

  const promise = (async (): Promise<ExportResult> => {
    const { width, height, fps, sampleRate, backgroundColor } = project.settings
    const durationSec = projectDuration(project)
    const totalFrames = frameCount(durationSec, fps)
    if (totalFrames === 0) return { ok: false, error: '타임라인이 비어 있습니다' }

    const scale = presetScale(project, settings.resolution)
    // 전환 효과음(phase-9)도 오디오로 간주 — 원본 오디오가 없어도 SFX 만으로 오디오 스트림 생성
    const sfxTriggers = collectSfxTriggers(project)
    const withAudio = hasAnyAudio(project) || sfxTriggers.length > 0

    const { jobId } = await window.editor.exportStart({
      outputPath,
      width,
      height,
      fps,
      sampleRate,
      crf: CRF[settings.quality],
      scaleWidth: scale.w,
      scaleHeight: scale.h,
      audio: withAudio ? 'mixdown' : 'none',
      vflip: true // WebGL readPixels 는 bottom-up
    })
    jobIdForCancel = jobId

    try {
      // 1) 오디오 믹스다운 (5.2.2) — 프리뷰와 동일 그래프를 오프라인 렌더 후 스트리밍
      if (withAudio) {
        const engine = playback.ensureAudioEngine(project)
        await engine.ensureAllLoaded(project)
        await engine.ensureSfxLoaded()
        // 믹스다운 길이는 durationSec 유지 — ffmpeg -shortest 가 영상 길이에 맞추므로 영상 뒤로 넘어가는 SFX 꼬리는 어차피 잘린다
        const mixdown = await renderMixdown(project, durationSec, (id) => engine.getBuffer(id), {
          triggers: sfxTriggers,
          getBuffer: (id) => engine.getSfxBuffer(id)
        })
        const pcm = interleaveStereo(mixdown)
        const bytes = new Uint8Array(pcm.buffer)
        for (let off = 0; off < bytes.byteLength; off += AUDIO_CHUNK_BYTES) {
          if (cancelled) throw new Error('cancelled')
          const chunk = bytes.slice(off, Math.min(bytes.byteLength, off + AUDIO_CHUNK_BYTES))
          await window.editor.exportAudioChunk(jobId, chunk.buffer)
        }
        await window.editor.exportAudioDone(jobId)
      }

      // 2) 프레임 렌더 → 파이프 (프리뷰와 동일 셰이더/장면 빌더, 내보내기는 원본 화질 소스)
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
          const items = await buildSceneAccurate(project, t, 'export')
          compositor.render(items, backgroundColor)
          const pixels = compositor.readPixels()
          await window.editor.exportFrame(jobId, pixels.slice().buffer)
          if (fi % 5 === 0 || fi === totalFrames - 1) onProgress(((fi + 1) / totalFrames) * 100)
        }
        const result = await window.editor.exportFinish(jobId)
        if (result.ok && result.stats) {
          const wallSec = (performance.now() - t0) / 1000
          console.info(
            `[export] ${result.stats.frames}프레임 / ${wallSec.toFixed(1)}s (x${(durationSec / wallSec).toFixed(2)} 실시간), ` +
              `파이프 ${result.stats.mbPerSec.toFixed(0)}MB/s`
          )
        }
        return result
      } finally {
        compositor.dispose()
      }
    } catch (e) {
      await window.editor.exportCancel(jobId).catch(() => {})
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, error: msg === 'cancelled' ? 'cancelled' : msg }
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

/**
 * 기준 프레임 캡처 (4.2.4 / 5.2.5) — 내보내기와 동일 경로로 시각 t 프레임을 렌더해 PNG dataURL 반환.
 * e2e 가 출력 파일의 같은 프레임과 SSIM 비교한다.
 */
export async function captureReferenceFrame(project: Project, t: number): Promise<string> {
  const { width, height, backgroundColor } = project.settings
  const canvas = document.createElement('canvas')
  const compositor = new Compositor(canvas, width, height)
  try {
    const items = await buildSceneAccurate(project, t, 'export')
    compositor.render(items, backgroundColor)
    return (canvas as HTMLCanvasElement).toDataURL('image/png')
  } finally {
    compositor.dispose()
  }
}
