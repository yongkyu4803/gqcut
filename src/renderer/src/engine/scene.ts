/**
 * 장면 빌더 — 타임라인 시각 t 의 레이어 목록을 만든다.
 * 프리뷰(poll: 논블로킹 최신 프레임)와 내보내기(accurate: 프레임 정확)가 같은 로직을 공유 → WYSIWYG.
 */
import type { Clip, Project, Track } from '@shared/model/types'
import type { Layer } from './compositor'
import { getImageBitmap, getVideoSource, VideoSource } from './videoSource'
import { rasterizeText, textAnimState } from './textRaster'

export function decodePath(project: Project, assetId: string): string | null {
  const asset = project.assets.find((a) => a.id === assetId)
  if (!asset || asset.status === 'missing') return null
  return asset.proxyPath ?? asset.path
}

export function clipSourceTime(clip: Clip, timelineT: number): number {
  return (clip.sourceIn ?? 0) + (timelineT - clip.timelineStart) * (clip.speed ?? 1)
}

export function activeClipsAt(project: Project, t: number): Array<{ track: Track; clip: Clip }> {
  const result: Array<{ track: Track; clip: Clip }> = []
  for (const track of project.tracks) {
    if (track.hidden) continue
    for (const clip of track.clips) {
      if (clip.timelineStart <= t && t < clip.timelineEnd) result.push({ track, clip })
    }
  }
  return result
}

function textLayer(clip: Clip, t: number): Layer | null {
  if (!clip.text) return null
  const raster = rasterizeText(clip.text)
  const anim = textAnimState(clip, t)
  const tr = clip.transform ?? { x: 0, y: 0, scale: 1, rotation: 0 }
  return {
    source: raster.canvas,
    srcWidth: raster.width,
    srcHeight: raster.height,
    fitToCanvas: false,
    opacity: (clip.opacity ?? 1) * anim.opacityMul,
    transform: {
      x: tr.x + anim.offsetX,
      y: tr.y + anim.offsetY,
      scale: tr.scale * anim.scaleMul,
      rotation: tr.rotation
    }
  }
}

/**
 * 프리뷰용 (논블로킹): 디코딩 완료된 최신 프레임을 사용하고 pump 로 다음 프레임을 요청.
 * 반환 순서는 아래 레이어 → 위 레이어 (tracks 배열은 위→아래이므로 역순).
 */
export function buildLayersPoll(project: Project, t: number): Layer[] {
  const layers: Layer[] = []
  for (let i = project.tracks.length - 1; i >= 0; i--) {
    const track = project.tracks[i]
    if (track.hidden || track.kind === 'audio') continue
    for (const clip of track.clips) {
      if (!(clip.timelineStart <= t && t < clip.timelineEnd)) continue
      if (clip.kind === 'text') {
        const layer = textLayer(clip, t)
        if (layer) layers.push(layer)
      } else if (clip.kind === 'video' && clip.assetId) {
        const path = decodePath(project, clip.assetId)
        if (!path) continue
        const srcPromise = getVideoSource(path)
        // 이미 로드된 소스만 사용 (Promise 상태 확인용 폴링 맵)
        const src = loadedSources.get(path)
        if (!src) {
          void srcPromise.then((s) => loadedSources.set(path, s)).catch(() => {})
          continue
        }
        src.pump(clipSourceTime(clip, t))
        const frame = src.displayFrame
        if (frame) {
          layers.push({
            source: frame,
            srcWidth: src.width,
            srcHeight: src.height,
            fitToCanvas: true,
            opacity: clip.opacity,
            transform: clip.transform
          })
        }
      } else if (clip.kind === 'image' && clip.assetId) {
        const path = decodePath(project, clip.assetId)
        if (!path) continue
        const bmp = loadedImages.get(path)
        if (!bmp) {
          void getImageBitmap(path)
            .then((b) => loadedImages.set(path, b))
            .catch(() => {})
          continue
        }
        layers.push({
          source: bmp,
          srcWidth: bmp.width,
          srcHeight: bmp.height,
          fitToCanvas: true,
          opacity: clip.opacity,
          transform: clip.transform
        })
      }
    }
  }
  return layers
}

/** 내보내기/시크용 (정확): 각 클립의 프레임을 await 로 확보 */
export async function buildLayersAccurate(project: Project, t: number): Promise<Layer[]> {
  const layers: Layer[] = []
  for (let i = project.tracks.length - 1; i >= 0; i--) {
    const track = project.tracks[i]
    if (track.hidden || track.kind === 'audio') continue
    for (const clip of track.clips) {
      if (!(clip.timelineStart <= t && t < clip.timelineEnd)) continue
      if (clip.kind === 'text') {
        const layer = textLayer(clip, t)
        if (layer) layers.push(layer)
      } else if (clip.kind === 'video' && clip.assetId) {
        const path = decodePath(project, clip.assetId)
        if (!path) continue
        const src = await getVideoSource(path)
        loadedSources.set(path, src)
        const frame = await src.getFrameAt(clipSourceTime(clip, t))
        if (frame) {
          layers.push({
            source: frame,
            srcWidth: src.width,
            srcHeight: src.height,
            fitToCanvas: true,
            opacity: clip.opacity,
            transform: clip.transform
          })
        }
      } else if (clip.kind === 'image' && clip.assetId) {
        const path = decodePath(project, clip.assetId)
        if (!path) continue
        const bmp = await getImageBitmap(path)
        loadedImages.set(path, bmp)
        layers.push({
          source: bmp,
          srcWidth: bmp.width,
          srcHeight: bmp.height,
          fitToCanvas: true,
          opacity: clip.opacity,
          transform: clip.transform
        })
      }
    }
  }
  return layers
}

const loadedSources = new Map<string, VideoSource>()
const loadedImages = new Map<string, ImageBitmap>()
