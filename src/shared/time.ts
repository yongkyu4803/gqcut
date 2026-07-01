/**
 * 시간·프레임 환산 (DATA-MODEL.md §4)
 * 내부 저장은 초(float), UI/시크/내보내기 경계 계산은 프레임 인덱스로 정규화.
 * 반올림 오차로 인한 프레임 누락을 막기 위해 경계 계산은 항상 프레임 단위로 스냅한다.
 */

export function timeToFrame(timeSeconds: number, fps: number): number {
  return Math.round(timeSeconds * fps)
}

export function frameToTime(frameIndex: number, fps: number): number {
  return frameIndex / fps
}

/** 초 값을 가장 가까운 프레임 경계로 스냅 */
export function snapToFrame(timeSeconds: number, fps: number): number {
  return frameToTime(timeToFrame(timeSeconds, fps), fps)
}

/** 타임라인 duration → 총 프레임 수 (내보내기 명세용) */
export function frameCount(durationSeconds: number, fps: number): number {
  return Math.max(0, Math.round(durationSeconds * fps))
}

export function formatTimecode(timeSeconds: number, fps: number): string {
  const totalFrames = timeToFrame(Math.max(0, timeSeconds), fps)
  const f = totalFrames % Math.round(fps)
  const totalSec = Math.floor(totalFrames / Math.round(fps))
  const s = totalSec % 60
  const m = Math.floor(totalSec / 60) % 60
  const h = Math.floor(totalSec / 3600)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(f)}`
}
