/**
 * 전환 효과음(SFX) 유닛 테스트 (phase-9)
 *  - collectSfxTriggers: 트리거 계산(피크=컷 중심), muted/비인접/미등록/비디오外 스킵, 볼륨 오버라이드
 *  - 스펙↔번들 자산 정합: SFX_LIBRARY 의 파일 존재 + duration + peakOffsetSec 가 실측 피크와 일치
 *  - 직렬화/생명주기: Transition.sound 왕복 + split 시 전환과 함께 제거
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createMediaClip, createProject, genId } from '@shared/model/factory'
import type { MediaAsset, Project, Transition } from '@shared/model/types'
import { collectSfxTriggers, SFX_BY_ID, SFX_LIBRARY } from '@shared/sfx'
import { addClip, splitClip } from '../src/renderer/src/state/commands'
import { serializeProject, deserializeProject } from '../src/renderer/src/state/store'

const SFX_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'sfx')

/** 16-bit PCM mono WAV → { sampleRate, samples } */
function readWav(path: string): { sampleRate: number; samples: Int16Array } {
  const buf = readFileSync(path)
  const sampleRate = buf.readUInt32LE(24)
  const dataSize = buf.readUInt32LE(40)
  const samples = new Int16Array(dataSize / 2)
  for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(44 + i * 2)
  return { sampleRate, samples }
}

function twoVideoClips(withTransition?: Transition): Project {
  let p = createProject()
  const track = p.tracks.find((t) => t.kind === 'video')!
  const asset: MediaAsset = { id: 'a1', kind: 'video', path: '/tmp/v.mp4', duration: 20, status: 'ok', hasAudio: false }
  p = { ...p, assets: [asset] }
  const c1 = createMediaClip(asset, 0)
  c1.id = 'c1'
  c1.timelineStart = 0
  c1.timelineEnd = 4
  c1.sourceOut = 4
  if (withTransition) c1.transitionOut = withTransition
  const c2 = createMediaClip(asset, 4)
  c2.id = 'c2'
  c2.timelineStart = 4
  c2.timelineEnd = 8
  c2.sourceIn = 4
  c2.sourceOut = 8
  p = addClip(p, track.id, c1)
  p = addClip(p, track.id, c2)
  return p
}

describe('collectSfxTriggers', () => {
  it('전환 sound 이 있으면 트리거 1개, 피크가 컷 중심(=4s)에 오도록 whenSec = 4 - peakOffset', () => {
    const p = twoVideoClips({ type: 'dissolve', duration: 1, sound: { id: 'whoosh' } })
    const triggers = collectSfxTriggers(p)
    expect(triggers).toHaveLength(1)
    const def = SFX_BY_ID.get('whoosh')!
    expect(triggers[0].sfxId).toBe('whoosh')
    expect(triggers[0].whenSec).toBeCloseTo(4 - def.peakOffsetSec, 5)
    expect(triggers[0].gain).toBe(def.defaultVolume)
  })

  it('sound.volume 이 defaultVolume 을 오버라이드', () => {
    const p = twoVideoClips({ type: 'dissolve', duration: 1, sound: { id: 'pop', volume: 0.3 } })
    expect(collectSfxTriggers(p)[0].gain).toBe(0.3)
  })

  it('sound 없는 전환은 트리거 없음', () => {
    const p = twoVideoClips({ type: 'dissolve', duration: 1 })
    expect(collectSfxTriggers(p)).toHaveLength(0)
  })

  it('미등록 sfxId 는 스킵', () => {
    const p = twoVideoClips({ type: 'dissolve', duration: 1, sound: { id: 'does-not-exist' } })
    expect(collectSfxTriggers(p)).toHaveLength(0)
  })

  it('muted 비디오 트랙은 스킵', () => {
    const p = twoVideoClips({ type: 'dissolve', duration: 1, sound: { id: 'whoosh' } })
    const muted = { ...p, tracks: p.tracks.map((t) => (t.kind === 'video' ? { ...t, muted: true } : t)) }
    expect(collectSfxTriggers(muted)).toHaveLength(0)
  })

  it('맞닿지 않은 클립 쌍은 스킵', () => {
    const p = twoVideoClips({ type: 'dissolve', duration: 1, sound: { id: 'whoosh' } })
    // c2 를 뒤로 밀어 간극 생성
    const gapped = {
      ...p,
      tracks: p.tracks.map((t) =>
        t.kind === 'video'
          ? { ...t, clips: t.clips.map((c) => (c.id === 'c2' ? { ...c, timelineStart: 5, timelineEnd: 9 } : c)) }
          : t
      )
    }
    expect(collectSfxTriggers(gapped)).toHaveLength(0)
  })

  it('whenSec 는 0 미만으로 내려가지 않는다', () => {
    // 컷이 아주 이른 지점(peakOffset 보다 작음)이라도 음수 방지
    let p = createProject()
    const track = p.tracks.find((t) => t.kind === 'video')!
    const asset: MediaAsset = { id: 'a1', kind: 'video', path: '/tmp/v.mp4', duration: 20, status: 'ok', hasAudio: false }
    p = { ...p, assets: [asset] }
    const c1 = { ...createMediaClip(asset, 0), id: 'c1', timelineStart: 0, timelineEnd: 0.1, sourceOut: 0.1, transitionOut: { type: 'dissolve', duration: 0.1, sound: { id: 'whoosh' } } as Transition }
    const c2 = { ...createMediaClip(asset, 0.1), id: 'c2', timelineStart: 0.1, timelineEnd: 4, sourceIn: 0.1, sourceOut: 4 }
    p = addClip(addClip(p, track.id, c1), track.id, c2)
    expect(collectSfxTriggers(p)[0].whenSec).toBe(0)
  })
})

describe('SFX 스펙 ↔ 번들 자산 정합', () => {
  for (const def of SFX_LIBRARY) {
    it(`${def.id}: 파일 존재 + peakOffsetSec 가 실측 피크(±40ms)와 일치`, () => {
      const { sampleRate, samples } = readWav(join(SFX_DIR, def.file))
      expect(samples.length).toBeGreaterThan(0)
      const durationSec = samples.length / sampleRate
      expect(def.peakOffsetSec).toBeLessThan(durationSec)
      let peakIdx = 0
      let peak = 0
      for (let i = 0; i < samples.length; i++) {
        const v = Math.abs(samples[i])
        if (v > peak) {
          peak = v
          peakIdx = i
        }
      }
      expect(peakIdx / sampleRate).toBeCloseTo(def.peakOffsetSec, 1) // ±0.05s 이내
    })
  }
})

describe('Transition.sound 직렬화 / 생명주기', () => {
  it('sound 필드가 저장→로드 왕복에서 보존된다', () => {
    const p = twoVideoClips({ type: 'wipe', duration: 1, sound: { id: 'boom', volume: 0.5 } })
    const round = deserializeProject(serializeProject(p))
    const c1 = round.tracks.flatMap((t) => t.clips).find((c) => c.id === 'c1')!
    expect(c1.transitionOut?.sound).toEqual({ id: 'boom', volume: 0.5 })
  })

  it('클립 분할 시 sound 는 전환을 따라 이동한다 (전환에 바인딩)', () => {
    // c1[0,4)+전환→ 을 2s 에서 분할하면 왼쪽[0,2)은 전환을 잃고, 오른쪽(새 클립, c2 와 인접)이 전환+sound 를 이어받는다
    const p = twoVideoClips({ type: 'dissolve', duration: 1, sound: { id: 'whoosh' } })
    const split = splitClip(p, 'c1', 2, genId('clip'))
    const c1 = split.tracks.flatMap((t) => t.clips).find((c) => c.id === 'c1')!
    expect(c1.transitionOut).toBeUndefined() // 왼쪽 조각은 전환 없음
    // sound 가 전환과 함께 새 인접 클립으로 이동 → 트리거는 여전히 1개, 컷은 이제 4s 그대로
    const triggers = collectSfxTriggers(split)
    expect(triggers).toHaveLength(1)
    expect(triggers[0].sfxId).toBe('whoosh')
    expect(triggers[0].whenSec).toBeCloseTo(4 - SFX_BY_ID.get('whoosh')!.peakOffsetSec, 5)
  })
})
