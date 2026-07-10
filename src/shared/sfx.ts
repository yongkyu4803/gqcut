/**
 * 전환 효과음(SFX) 단일 정의 (phase-9) — main/renderer/테스트 공유.
 *  - SFX_LIBRARY: 내장 효과음 등록부(id·라벨·파일명·기본볼륨·피크시각). 파일은 resources/sfx/ 에 번들.
 *    (scripts/gen-sfx.mjs 로 합성 — 직접 생성물이라 저작권 이슈 없음. peakOffsetSec 는 그 실측 피크와 일치)
 *  - collectSfxTriggers: 프로젝트 → 전환 효과음 트리거 목록(순수). 프리뷰·내보내기 오디오 스케줄러가 공유.
 *
 * 원칙: 효과음의 지각적 피크가 컷 중심(a.timelineEnd)에 오도록 재생 시작을 peakOffsetSec 만큼 앞당긴다.
 */
import type { Project } from './model/types'

export interface SfxDef {
  id: string
  label: string
  /** resources/sfx/ 하위 파일명 */
  file: string
  /** 기준 볼륨(0~1) — sound.volume 미지정 시 사용 */
  defaultVolume: number
  /** 클립 시작~지각적 피크까지의 시간(초) — 컷 중심 정렬용 */
  peakOffsetSec: number
}

export const SFX_LIBRARY: SfxDef[] = [
  { id: 'whoosh', label: '휙 (스와이프)', file: 'whoosh.wav', defaultVolume: 0.8, peakOffsetSec: 0.256 },
  { id: 'swish', label: '샤악 (빠른 스윕)', file: 'swish.wav', defaultVolume: 0.8, peakOffsetSec: 0.05 },
  { id: 'pop', label: '팝', file: 'pop.wav', defaultVolume: 0.75, peakOffsetSec: 0.002 },
  { id: 'click', label: '틱 (클릭)', file: 'click.wav', defaultVolume: 0.7, peakOffsetSec: 0.002 },
  { id: 'boom', label: '붐 (임팩트)', file: 'boom.wav', defaultVolume: 0.85, peakOffsetSec: 0.005 }
]

export const SFX_BY_ID = new Map<string, SfxDef>(SFX_LIBRARY.map((s) => [s.id, s]))

/** 오디오 스케줄러에 넘길 원샷 트리거 — whenSec: 타임라인상 재생 시작 시각, gain: 최종 볼륨(트랙 게인 제외) */
export interface SfxTrigger {
  sfxId: string
  whenSec: number
  gain: number
}

/**
 * 전환 효과음 트리거 수집 (순수). 전환은 비디오 트랙에서만 렌더되므로(scene.ts) 여기서도 비디오 트랙만 본다.
 * muted 비디오 트랙·인접하지 않은 쌍·미등록 sfxId·sound 없는 전환은 건너뛴다.
 */
export function collectSfxTriggers(project: Project, byId: Map<string, SfxDef> = SFX_BY_ID): SfxTrigger[] {
  const out: SfxTrigger[] = []
  for (const track of project.tracks) {
    if (track.kind !== 'video' || track.muted) continue
    const clips = [...track.clips].sort((a, b) => a.timelineStart - b.timelineStart)
    for (let i = 0; i < clips.length - 1; i++) {
      const a = clips[i]
      const b = clips[i + 1]
      const sound = a.transitionOut?.sound
      if (!sound || Math.abs(b.timelineStart - a.timelineEnd) > 1e-3) continue
      const def = byId.get(sound.id)
      if (!def) continue
      const cut = a.timelineEnd
      out.push({
        sfxId: def.id,
        whenSec: Math.max(0, cut - def.peakOffsetSec),
        gain: sound.volume ?? def.defaultVolume
      })
    }
  }
  return out
}
