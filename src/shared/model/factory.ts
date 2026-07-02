import type { Clip, MediaAsset, Project, TextContent, Track, Transform } from './types'
import { SCHEMA_VERSION } from './types'

let counter = 0
/** 충돌 없는 짧은 id (프로세스 로컬 카운터 + 시각) */
export function genId(prefix: string): string {
  counter += 1
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`
}

export function createProject(name = '제목 없는 프로젝트'): Project {
  const now = new Date().toISOString()
  return {
    schemaVersion: SCHEMA_VERSION,
    id: genId('proj'),
    name,
    settings: {
      width: 1920,
      height: 1080,
      fps: 30,
      sampleRate: 48000,
      backgroundColor: '#000000',
      masterVolume: 1
    },
    assets: [],
    tracks: [
      { id: genId('trk'), kind: 'text', clips: [] },
      { id: genId('trk'), kind: 'video', clips: [] },
      { id: genId('trk'), kind: 'audio', clips: [], volume: 1 }
    ],
    createdAt: now,
    updatedAt: now
  }
}

export function createTrack(kind: Track['kind']): Track {
  return { id: genId('trk'), kind, clips: [], ...(kind !== 'text' ? { volume: 1 } : {}) }
}

/** 미디어 클립 생성 — 소스 전체 구간을 timelineStart 에 배치 */
export function createMediaClip(asset: MediaAsset, timelineStart: number): Clip {
  const duration = asset.duration
  return {
    id: genId('clip'),
    assetId: asset.id,
    kind: asset.kind,
    timelineStart,
    timelineEnd: timelineStart + duration,
    // 이미지는 소스 시간축이 없다 — sourceIn/Out 을 두면 좌측 트림이 원래 시작점에 막힌다
    ...(asset.kind !== 'image' ? { sourceIn: 0, sourceOut: duration, speed: 1, volume: 1 } : {}),
    opacity: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0 },
    effects: []
  }
}

export const DEFAULT_TEXT: TextContent = {
  value: '텍스트',
  fontFamily: 'sans-serif',
  fontSize: 72,
  color: '#ffffff',
  align: 'center',
  bold: false,
  italic: false,
  stroke: { color: '#000000', width: 4 }
}

export function createTextClip(timelineStart: number, duration = 3, transform?: Transform): Clip {
  return {
    id: genId('clip'),
    kind: 'text',
    timelineStart,
    timelineEnd: timelineStart + duration,
    opacity: 1,
    transform: transform ?? { x: 0, y: 0, scale: 1, rotation: 0 },
    text: { ...DEFAULT_TEXT }
  }
}

/** 자동 자막 기본 스타일 — 하단 중앙, 외곽선 + 반투명 배경(가독성) */
export const SUBTITLE_TEXT: TextContent = {
  value: '',
  fontFamily: 'sans-serif',
  fontSize: 48,
  color: '#ffffff',
  align: 'center',
  bold: true,
  stroke: { color: '#000000', width: 5 },
  background: { color: 'rgba(0,0,0,0.5)', padding: 12 }
}

/**
 * 자막 클립 (3.2.3) — STT 결과 배치용. 하단 중앙 기본 위치(캔버스 높이의 ~76% 지점).
 */
export function createSubtitleClip(timelineStart: number, timelineEnd: number, text: string, canvasHeight: number): Clip {
  return {
    id: genId('clip'),
    kind: 'text',
    timelineStart,
    timelineEnd,
    opacity: 1,
    // 화면 중앙 기준 오프셋 — 하단쪽으로 (높이의 26% 아래)
    transform: { x: 0, y: Math.round(canvasHeight * 0.26), scale: 1, rotation: 0 },
    text: { ...SUBTITLE_TEXT, value: text }
  }
}
