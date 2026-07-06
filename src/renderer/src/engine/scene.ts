/**
 * 장면 빌더 — 타임라인 시각 t 의 SceneItem(레이어/전환) 목록을 만든다.
 * 프리뷰(poll)와 내보내기(accurate)가 같은 로직을 공유 → WYSIWYG.
 *
 * 전환(4.2): 인접 클립 쌍에서 앞 클립의 transitionOut 이 원본 (DATA-MODEL §1.1).
 * 전환 구간에서는 두 클립의 프레임을 각각 확보해 전환 아이템으로 내보낸다.
 * 핸들 부족 시 VideoSource.getFrameAt 이 소스 범위로 클램프 → 자연스러운 프레임 홀드 fallback.
 */
import type { Clip, Project, Track } from '@shared/model/types'
import { fadeOpacityMul, resolveColorAdjust, transitionZone } from '@shared/effects-spec'
import type { Layer, SceneItem } from './compositor'
import { getImageBitmap, getVideoSource, VideoSource } from './videoSource'
import { rasterizeText, textAnimState } from './textRaster'

export type DecodePurpose = 'preview' | 'export'

/**
 * 디코딩에 사용할 파일 경로.
 * - preview: 성능 프록시(perfProxy) > 호환 프록시 > 원본
 * - export: 호환 프록시(WebCodecs 필수) > 원본 — 성능 프록시는 절대 사용하지 않는다 (6.2: 내보내기는 원본 품질)
 */
export function decodePath(project: Project, assetId: string, purpose: DecodePurpose): string | null {
  const asset = project.assets.find((a) => a.id === assetId)
  if (!asset || asset.status === 'missing') return null
  if (purpose === 'preview') return asset.perfProxyPath ?? asset.proxyPath ?? asset.path
  return asset.proxyPath ?? asset.path
}

export function clipSourceTime(clip: Clip, timelineT: number): number {
  return (clip.sourceIn ?? 0) + (timelineT - clip.timelineStart) * (clip.speed ?? 1)
}

interface TransitionAt {
  a: Clip
  b: Clip
  type: string
  progress: number
}

/** t 가 이 트랙의 전환 구간 안이면 전환 정보 반환 */
function findTransitionAt(track: Track, t: number): TransitionAt | null {
  const clips = [...track.clips].sort((x, y) => x.timelineStart - y.timelineStart)
  for (let i = 0; i < clips.length - 1; i++) {
    const a = clips[i]
    const b = clips[i + 1]
    if (!a.transitionOut || Math.abs(b.timelineStart - a.timelineEnd) > 1e-3) continue
    const zone = transitionZone(a.timelineEnd, a.transitionOut.duration, a.timelineStart, b.timelineEnd)
    if (t >= zone.start && t < zone.end && zone.end > zone.start) {
      return { a, b, type: a.transitionOut.type, progress: (t - zone.start) / (zone.end - zone.start) }
    }
  }
  return null
}

function textLayer(clip: Clip, t: number): Layer | null {
  if (!clip.text) return null
  const anim = textAnimState(clip, t)
  // 타이프라이터: 가시 비율 → 글자 수. 0글자면 레이어 생략 (빈 배경 박스 방지)
  const totalChars = clip.text.value.length
  const visibleChars = anim.visibleRatio >= 1 ? undefined : Math.round(anim.visibleRatio * totalChars)
  if (visibleChars !== undefined && visibleChars <= 0) return null
  const raster = rasterizeText(clip.text, visibleChars)
  const tr = clip.transform ?? { x: 0, y: 0, scale: 1, rotation: 0 }
  return {
    source: raster.canvas,
    srcWidth: raster.width,
    srcHeight: raster.height,
    fitToCanvas: false,
    opacity: (clip.opacity ?? 1) * anim.opacityMul,
    adjust: resolveColorAdjust(clip.effects),
    transform: {
      x: tr.x + anim.offsetX,
      y: tr.y + anim.offsetY,
      scale: tr.scale * anim.scaleMul,
      rotation: tr.rotation
    }
  }
}

function visualLayerBase(clip: Clip, t: number): Pick<Layer, 'fitToCanvas' | 'opacity' | 'transform' | 'adjust'> {
  // 페이드 인/아웃은 영상 불투명도에도 적용 (오디오 게인과 동일 수식 — effects-spec)
  const fade = fadeOpacityMul(clip.fadeIn, clip.fadeOut, t - clip.timelineStart, clip.timelineEnd - clip.timelineStart)
  return {
    fitToCanvas: true,
    opacity: (clip.opacity ?? 1) * fade,
    transform: clip.transform,
    adjust: resolveColorAdjust(clip.effects)
  }
}

/** 같은 자산의 두 구간이 전환에서 동시에 필요할 수 있어 역할별 인스턴스 키를 지원 */
function pollVideoLayer(project: Project, clip: Clip, t: number, instanceKey?: string): Layer | null {
  if (!clip.assetId) return null
  const path = decodePath(project, clip.assetId, 'preview')
  if (!path) return null
  const src = loadedSources.get(cacheKey(path, instanceKey))
  if (!src) {
    void getVideoSource(path, instanceKey)
      .then((s) => loadedSources.set(cacheKey(path, instanceKey), s))
      .catch(() => {})
    return null
  }
  src.pump(clipSourceTime(clip, t))
  const frame = src.displayFrame
  if (!frame) return null
  return { source: frame, srcWidth: src.width, srcHeight: src.height, ...visualLayerBase(clip, t) }
}

function pollImageLayer(project: Project, clip: Clip, t: number): Layer | null {
  if (!clip.assetId) return null
  const path = decodePath(project, clip.assetId, 'preview')
  if (!path) return null
  const bmp = loadedImages.get(path)
  if (!bmp) {
    void getImageBitmap(path)
      .then((b) => loadedImages.set(path, b))
      .catch(() => {})
    return null
  }
  return { source: bmp, srcWidth: bmp.width, srcHeight: bmp.height, ...visualLayerBase(clip, t) }
}

function pollClipLayer(project: Project, clip: Clip, t: number, instanceKey?: string): Layer | null {
  if (clip.kind === 'text') return textLayer(clip, t)
  if (clip.kind === 'video') return pollVideoLayer(project, clip, t, instanceKey)
  if (clip.kind === 'image') return pollImageLayer(project, clip, t)
  return null
}

async function accurateClipLayer(
  project: Project,
  clip: Clip,
  t: number,
  purpose: DecodePurpose,
  instanceKey?: string
): Promise<Layer | null> {
  if (clip.kind === 'text') return textLayer(clip, t)
  if (!clip.assetId) return null
  const path = decodePath(project, clip.assetId, purpose)
  if (!path) return null
  if (clip.kind === 'image') {
    const bmp = await getImageBitmap(path)
    loadedImages.set(path, bmp)
    return { source: bmp, srcWidth: bmp.width, srcHeight: bmp.height, ...visualLayerBase(clip, t) }
  }
  const src = await getVideoSource(path, instanceKey)
  loadedSources.set(cacheKey(path, instanceKey), src)
  const frame = await src.getFrameAt(clipSourceTime(clip, t))
  if (!frame) return null
  return { source: frame, srcWidth: src.width, srcHeight: src.height, ...visualLayerBase(clip, t) }
}

/** 프리뷰용 (논블로킹). 반환 순서는 아래→위 레이어 (tracks 배열은 위→아래이므로 역순). */
export function buildScenePoll(project: Project, t: number): SceneItem[] {
  const items: SceneItem[] = []
  for (let i = project.tracks.length - 1; i >= 0; i--) {
    const track = project.tracks[i]
    if (track.hidden || track.kind === 'audio') continue

    const transition = track.kind === 'video' ? findTransitionAt(track, t) : null
    if (transition) {
      items.push({
        kind: 'transition',
        a: pollClipLayer(project, transition.a, t),
        b: pollClipLayer(project, transition.b, t, 'trans-b'),
        type: transition.type,
        progress: transition.progress
      })
      continue
    }
    for (const clip of track.clips) {
      if (!(clip.timelineStart <= t && t < clip.timelineEnd)) continue
      const layer = pollClipLayer(project, clip, t)
      if (layer) items.push({ kind: 'layer', layer })
    }
  }
  return items
}

/** 내보내기/시크용 (프레임 정확) */
export async function buildSceneAccurate(project: Project, t: number, purpose: DecodePurpose): Promise<SceneItem[]> {
  const items: SceneItem[] = []
  for (let i = project.tracks.length - 1; i >= 0; i--) {
    const track = project.tracks[i]
    if (track.hidden || track.kind === 'audio') continue

    const transition = track.kind === 'video' ? findTransitionAt(track, t) : null
    if (transition) {
      items.push({
        kind: 'transition',
        a: await accurateClipLayer(project, transition.a, t, purpose),
        b: await accurateClipLayer(project, transition.b, t, purpose, 'trans-b'),
        type: transition.type,
        progress: transition.progress
      })
      continue
    }
    for (const clip of track.clips) {
      if (!(clip.timelineStart <= t && t < clip.timelineEnd)) continue
      const layer = await accurateClipLayer(project, clip, t, purpose)
      if (layer) items.push({ kind: 'layer', layer })
    }
  }
  return items
}

function cacheKey(path: string, instanceKey?: string): string {
  return instanceKey ? `${path}|${instanceKey}` : path
}

const loadedSources = new Map<string, VideoSource>()
const loadedImages = new Map<string, ImageBitmap>()
