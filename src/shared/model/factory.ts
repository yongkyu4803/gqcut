import type { Clip, MediaAsset, Project, TextContent, Track, Transform } from './types'
import { SCHEMA_VERSION } from './types'
import { bottomSafeLineFromCenter } from '../safeArea'

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
 * 자막 하단 기준선 y 오프셋 (캔버스 중앙 기준, +아래, 프로젝트 px).
 * 텍스트 블록의 "하단"을 프리뷰 하단 세이프 가이드선(safeArea.bottomSafeLineFromCenter)에 맞춘다
 * — 생성된 자막이 화면의 자막 가이드선과 정확히 정렬된다. fontSize 로 라스터 반높이를 근사 보정해
 * 글자 크기가 달라도 하단선이 일정하다. (transform.y 는 생성 시 고정 — 이후 set_transform 으로 조정 가능)
 */
export function subtitleBottomY(canvasHeight: number, fontSize: number): number {
  const approxHalfHeight = fontSize * 0.9 // 라스터 반높이 근사(줄높이+외곽선/배경 패딩 여유)
  return Math.round(bottomSafeLineFromCenter(canvasHeight) - approxHalfHeight)
}

/**
 * 자막 클립 (3.2.3) — STT 결과 배치용. 화면 하단 기준선에 정렬(자막 안전 영역).
 */
export function createSubtitleClip(timelineStart: number, timelineEnd: number, text: string, canvasHeight: number): Clip {
  return {
    id: genId('clip'),
    kind: 'text',
    timelineStart,
    timelineEnd,
    opacity: 1,
    transform: { x: 0, y: subtitleBottomY(canvasHeight, SUBTITLE_TEXT.fontSize), scale: 1, rotation: 0 },
    text: { ...SUBTITLE_TEXT, value: text }
  }
}
