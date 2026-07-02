/**
 * 임포트 플로우 (0.3.1, 0.4) — 프로브 → (필요 시) 호환 프록시 → 오디오 추출 → 자산 등록.
 */
import type { MediaAsset } from '@shared/model/types'
import { genId } from '@shared/model/factory'
import { useEditor } from '@renderer/state/store'
import { addAsset } from '@renderer/state/commands'
import { playback } from '@renderer/engine/playback'

/** 히스토리에 남기지 않는 자산 패치 (프록시/오디오 추출 완료 반영) */
function patchAssetSilently(assetId: string, patch: Partial<MediaAsset>): void {
  useEditor.setState((s) => ({
    project: {
      ...s.project,
      assets: s.project.assets.map((a) => (a.id === assetId ? { ...a, ...patch } : a))
    }
  }))
}

export async function importFile(path: string): Promise<MediaAsset> {
  const probe = await window.editor.probe(path)

  const asset: MediaAsset = {
    id: genId('asset'),
    kind: probe.kind,
    path,
    duration: probe.kind === 'image' ? 5 : probe.durationSec, // 이미지 기본 5초
    width: probe.width,
    height: probe.height,
    fps: probe.fps,
    vfr: probe.vfr,
    codec: probe.videoCodec ?? probe.audioCodec,
    hasAudio: probe.hasAudio,
    status: 'ok'
  }
  useEditor.getState().dispatch('미디어 임포트', (p) => addAsset(p, asset))

  // 호환 프록시 (0.4): WebCodecs 미지원 코덱 또는 VFR → H.264 CFR 트랜스코딩
  if (probe.kind === 'video' && !probe.likelyWebCodecsSupported) {
    const store = useEditor.getState()
    store.setProxyProgress(asset.id, 0)
    const off = window.editor.onProxyProgress((prog) => {
      if (prog.jobId === asset.id) useEditor.getState().setProxyProgress(asset.id, prog.percent)
    })
    try {
      const proxyPath = await window.editor.makeProxy(path, asset.id)
      patchAssetSilently(asset.id, { proxyPath })
    } finally {
      off()
      useEditor.getState().setProxyProgress(asset.id, null)
    }
  }

  // 오디오 추출 (재생/파형/믹스다운 공용)
  if (probe.hasAudio) {
    const wav = await window.editor.extractAudio(path)
    if (wav) {
      patchAssetSilently(asset.id, { audioWavPath: wav })
      playback.preloadAudio(useEditor.getState().project)
    }
  }

  // 성능 프록시 (6.2.1): 1080p 초과 소스는 720p 프리뷰 프록시를 백그라운드 생성 (논블로킹)
  if (probe.kind === 'video' && (probe.height ?? 0) > 1080) {
    const jobId = `perf_${asset.id}`
    useEditor.getState().setProxyProgress(asset.id, 0)
    const off = window.editor.onProxyProgress((prog) => {
      if (prog.jobId === jobId) useEditor.getState().setProxyProgress(asset.id, prog.percent)
    })
    void window.editor
      .makePerfProxy(path, jobId)
      .then((perfProxyPath) => patchAssetSilently(asset.id, { perfProxyPath }))
      .catch(() => {})
      .finally(() => {
        off()
        useEditor.getState().setProxyProgress(asset.id, null)
      })
  }

  return useEditor.getState().project.assets.find((a) => a.id === asset.id) ?? asset
}

/** 누락 파일 재연결 (6.1.3) — 새 경로로 프로브/프록시/오디오를 다시 구성 */
export async function relinkAsset(assetId: string): Promise<void> {
  const paths = await window.editor.openVideoDialog()
  if (paths.length === 0) return
  const newPath = paths[0]
  const probe = await window.editor.probe(newPath)

  patchAssetSilently(assetId, {
    path: newPath,
    status: 'ok',
    proxyPath: undefined,
    perfProxyPath: undefined,
    audioWavPath: undefined,
    width: probe.width,
    height: probe.height,
    fps: probe.fps,
    vfr: probe.vfr,
    codec: probe.videoCodec ?? probe.audioCodec,
    hasAudio: probe.hasAudio
  })

  if (probe.kind === 'video' && !probe.likelyWebCodecsSupported) {
    const proxyPath = await window.editor.makeProxy(newPath, assetId)
    patchAssetSilently(assetId, { proxyPath })
  }
  if (probe.hasAudio) {
    const wav = await window.editor.extractAudio(newPath)
    if (wav) patchAssetSilently(assetId, { audioWavPath: wav })
  }
  playback.preloadAudio(useEditor.getState().project)
  playback.refresh()
}

export async function importViaDialog(): Promise<void> {
  const paths = await window.editor.openVideoDialog()
  for (const p of paths) {
    try {
      await importFile(p)
    } catch (e) {
      // 손상 파일 등 — 앱은 계속 동작 (0.2 graceful)
      alert(`임포트 실패: ${p}\n${e instanceof Error ? e.message : e}`)
    }
  }
}
