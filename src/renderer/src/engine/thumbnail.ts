/**
 * 썸네일 생성 유틸 (0.3.4) — 특정 timestamp 프레임을 작은 dataURL 로.
 * VideoSource.getFrameAt(프레임 정확 추출)을 재사용한다.
 */
import { getImageBitmap, getVideoSource } from './videoSource'

const cache = new Map<string, Promise<string | null>>()

export function makeThumbnail(filePath: string, kind: 'video' | 'image', tSec = 0, width = 160): Promise<string | null> {
  const key = `${filePath}@${tSec}`
  let p = cache.get(key)
  if (!p) {
    p = (async () => {
      try {
        let srcW: number
        let srcH: number
        let source: CanvasImageSource
        if (kind === 'image') {
          const bmp = await getImageBitmap(filePath)
          srcW = bmp.width
          srcH = bmp.height
          source = bmp
        } else {
          const vs = await getVideoSource(filePath)
          const frame = await vs.getFrameAt(tSec)
          if (!frame) return null
          srcW = vs.width
          srcH = vs.height
          source = frame as unknown as CanvasImageSource
        }
        const h = Math.max(1, Math.round((width * srcH) / srcW))
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = h
        canvas.getContext('2d')!.drawImage(source, 0, 0, width, h)
        return canvas.toDataURL('image/jpeg', 0.7)
      } catch {
        return null
      }
    })()
    cache.set(key, p)
  }
  return p
}
