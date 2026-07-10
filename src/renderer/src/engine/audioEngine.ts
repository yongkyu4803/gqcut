/**
 * 오디오 엔진 (1.4.5, 2.2, 5.1) — Web Audio 그래프:
 *   클립 SourceNode → 클립 GainNode(볼륨/페이드) → 트랙 GainNode → 마스터 GainNode → Destination
 * AudioContext.currentTime 이 재생의 마스터 클럭 (1.4.6 A/V 싱크 기준).
 *
 * 믹스다운(5.1.2 결정): 내보내기는 OfflineAudioContext 로 같은 그래프(scheduleProjectAudio)를
 * 오프라인 렌더 → 프리뷰와 결과가 수식 수준에서 동일 (오디오 WYSIWYG).
 */
import type { MediaAsset, Project } from '@shared/model/types'
import { collectSfxTriggers, SFX_BY_ID, type SfxTrigger } from '@shared/sfx'
import { mediaUrl } from './demux'

interface ActiveSource {
  node: AudioBufferSourceNode
  clipGain: GainNode
}

export interface ScheduledGraph {
  sources: ActiveSource[]
  trackGains: Map<string, GainNode>
  master: GainNode
}

/**
 * 프로젝트 오디오를 그래프로 스케줄 — 라이브(AudioContext)와 오프라인(OfflineAudioContext) 공용.
 * anchorCtxTime: 타임라인 fromT 가 대응하는 ctx 시각.
 */
export function scheduleProjectAudio(
  ctx: BaseAudioContext,
  destination: AudioNode,
  project: Project,
  fromT: number,
  anchorCtxTime: number,
  getBuffer: (assetId: string) => AudioBuffer | undefined,
  /** 전환 효과음 원샷 (phase-9) — 없으면 SFX 미재생. 트랙 게인을 우회해 마스터에 직접 붙는다(트리거 수집 시 muted 트랙 제외). */
  sfx?: { triggers: SfxTrigger[]; getBuffer: (id: string) => AudioBuffer | undefined }
): ScheduledGraph {
  const master = ctx.createGain()
  master.gain.value = project.settings.masterVolume
  master.connect(destination)

  const trackGains = new Map<string, GainNode>()
  const sources: ActiveSource[] = []

  for (const track of project.tracks) {
    if (track.kind === 'text' || track.muted) continue
    const trackGain = ctx.createGain()
    trackGain.gain.value = track.volume ?? 1
    trackGain.connect(master)
    trackGains.set(track.id, trackGain)

    for (const clip of track.clips) {
      if (clip.timelineEnd <= fromT + 1e-6) continue
      const buffer = clip.assetId ? getBuffer(clip.assetId) : undefined
      if (!buffer) continue

      const speed = clip.speed ?? 1
      const startT = Math.max(clip.timelineStart, fromT)
      const when = anchorCtxTime + (startT - fromT)
      const offset = (clip.sourceIn ?? 0) + (startT - clip.timelineStart) * speed
      const durationSrc = (clip.timelineEnd - startT) * speed

      const node = ctx.createBufferSource()
      node.buffer = buffer
      node.playbackRate.value = speed

      const clipGain = ctx.createGain()
      scheduleClipGain(ctx, clipGain, clip.volume ?? 1, clip.fadeIn ?? 0, clip.fadeOut ?? 0, clip.timelineStart, clip.timelineEnd, fromT, anchorCtxTime)

      node.connect(clipGain)
      clipGain.connect(trackGain)
      node.start(when, Math.max(0, offset), Math.max(0.001, durationSrc))
      sources.push({ node, clipGain })
    }
  }

  // 전환 효과음 원샷 스케줄 (phase-9) — 마스터에 직접 붙이고, 중도 진입 시 offset 재생으로 정확한 타이밍 유지
  if (sfx) {
    for (const trig of sfx.triggers) {
      const buffer = sfx.getBuffer(trig.sfxId)
      if (!buffer) continue
      if (trig.whenSec + buffer.duration <= fromT + 1e-6) continue // 이미 끝난 효과음
      const startT = Math.max(trig.whenSec, fromT)
      const when = anchorCtxTime + (startT - fromT)
      const offset = startT - trig.whenSec // fromT 가 효과음 중간이면 그만큼 건너뛴다
      const node = ctx.createBufferSource()
      node.buffer = buffer
      const gain = ctx.createGain()
      gain.gain.value = trig.gain
      node.connect(gain)
      gain.connect(master)
      node.start(when, Math.max(0, offset))
      sources.push({ node, clipGain: gain })
    }
  }
  return { sources, trackGains, master }
}

/** 페이드 인/아웃 automation (2.2.3) — 타임라인 시각을 ctx 시각으로 매핑해 램프 */
function scheduleClipGain(
  ctx: BaseAudioContext,
  gain: GainNode,
  volume: number,
  fadeIn: number,
  fadeOut: number,
  clipStart: number,
  clipEnd: number,
  fromT: number,
  anchorCtxTime: number
): void {
  const toCtx = (t: number): number => anchorCtxTime + (t - fromT)
  const g = gain.gain
  const volAt = (t: number): number => {
    let v = volume
    if (fadeIn > 0 && t < clipStart + fadeIn) v *= Math.max(0, (t - clipStart) / fadeIn)
    if (fadeOut > 0 && t > clipEnd - fadeOut) v *= Math.max(0, (clipEnd - t) / fadeOut)
    return v
  }
  const startT = Math.max(clipStart, fromT)
  g.setValueAtTime(volAt(startT), Math.max(ctx.currentTime, toCtx(startT)))
  if (fadeIn > 0 && clipStart + fadeIn > startT) g.linearRampToValueAtTime(volume, toCtx(clipStart + fadeIn))
  if (fadeOut > 0 && clipEnd - fadeOut >= startT) {
    g.setValueAtTime(volume, toCtx(Math.max(startT, clipEnd - fadeOut)))
    g.linearRampToValueAtTime(0, toCtx(clipEnd))
  }
}

/** 오디오 믹스다운 (5.1.2/5.2.2) — 프리뷰와 동일 그래프를 오프라인 렌더 */
export async function renderMixdown(
  project: Project,
  durationSec: number,
  getBuffer: (assetId: string) => AudioBuffer | undefined,
  sfx?: { triggers: SfxTrigger[]; getBuffer: (id: string) => AudioBuffer | undefined }
): Promise<AudioBuffer> {
  const sampleRate = project.settings.sampleRate
  const length = Math.max(1, Math.ceil(durationSec * sampleRate))
  const ctx = new OfflineAudioContext(2, length, sampleRate)
  scheduleProjectAudio(ctx, ctx.destination, project, 0, 0, getBuffer, sfx)
  return ctx.startRendering()
}

/** AudioBuffer → 인터리브 f32le 스테레오 (FFmpeg -f f32le 입력용) */
export function interleaveStereo(buffer: AudioBuffer): Float32Array {
  const n = buffer.length
  const l = buffer.getChannelData(0)
  const r = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : l
  const out = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    out[i * 2] = l[i]
    out[i * 2 + 1] = r[i]
  }
  return out
}

export class AudioEngine {
  readonly ctx: AudioContext
  private master: GainNode
  private liveMaster: GainNode | null = null // scheduleProjectAudio 가 만든 그래프의 마스터
  private buffers = new Map<string, AudioBuffer>() // assetId → 디코딩된 오디오
  private loading = new Map<string, Promise<AudioBuffer | null>>()
  private sfxBuffers = new Map<string, AudioBuffer>() // sfxId → 디코딩된 효과음 (phase-9)
  private sfxPaths = new Map<string, string>() // sfxId → 절대경로 (main IPC 로 주입)
  private sfxLoading: Promise<void> | null = null
  private active: ActiveSource[] = []
  private trackGains = new Map<string, GainNode>()
  private anchorCtxTime = 0
  private anchorT = 0
  private _playing = false

  constructor(sampleRate: number) {
    this.ctx = new AudioContext({ sampleRate, latencyHint: 'interactive' })
    this.master = this.ctx.createGain()
    this.master.connect(this.ctx.destination)
  }

  get playing(): boolean {
    return this._playing
  }

  /** 마스터 클럭 기준 현재 타임라인 시각 (1.4.6) */
  currentTime(): number {
    return this._playing ? this.anchorT + (this.ctx.currentTime - this.anchorCtxTime) : this.anchorT
  }

  /** wav(사전 추출) 를 AudioBuffer 로 디코딩·캐시 */
  async loadAsset(asset: MediaAsset): Promise<AudioBuffer | null> {
    const cached = this.buffers.get(asset.id)
    if (cached) return cached
    if (!asset.audioWavPath) return null
    let p = this.loading.get(asset.id)
    if (!p) {
      p = fetch(mediaUrl(asset.audioWavPath))
        .then((r) => r.arrayBuffer())
        .then((ab) => this.ctx.decodeAudioData(ab))
        .then((buf) => {
          this.buffers.set(asset.id, buf)
          return buf
        })
        .catch(() => null)
      this.loading.set(asset.id, p)
    }
    return p
  }

  getBuffer(assetId: string): AudioBuffer | undefined {
    return this.buffers.get(assetId)
  }

  getSfxBuffer(id: string): AudioBuffer | undefined {
    return this.sfxBuffers.get(id)
  }

  /** 내장 효과음 절대경로 등록 (main sfx:paths IPC 결과) */
  setSfxPaths(entries: Array<{ id: string; path: string }>): void {
    for (const e of entries) this.sfxPaths.set(e.id, e.path)
    this.sfxLoading = null // 새 경로 반영 위해 재로드 허용
  }

  /** 등록된 효과음을 media:// 로 fetch·디코딩·캐시 (멱등, 총 수백 KB) */
  async ensureSfxLoaded(): Promise<void> {
    if (this.sfxLoading) return this.sfxLoading
    this.sfxLoading = Promise.all(
      [...this.sfxPaths].map(async ([id, path]) => {
        if (this.sfxBuffers.has(id)) return
        try {
          const ab = await fetch(mediaUrl(path)).then((r) => r.arrayBuffer())
          const buf = await this.ctx.decodeAudioData(ab)
          this.sfxBuffers.set(id, buf)
        } catch {
          /* 개별 효과음 로드 실패는 무시 — 재생 시 스킵 */
        }
      })
    ).then(() => {})
    return this.sfxLoading
  }

  /** 미리듣기 (9.4.3) — 효과음 1회 즉시 재생 (재생 중에도 마스터로 단발) */
  async playSfxOnce(id: string, gain: number): Promise<void> {
    await this.ctx.resume()
    await this.ensureSfxLoaded()
    const buffer = this.sfxBuffers.get(id)
    if (!buffer) return
    const node = this.ctx.createBufferSource()
    node.buffer = buffer
    const g = this.ctx.createGain()
    g.gain.value = gain
    node.connect(g)
    g.connect(this.master)
    node.start()
  }

  /** 재생 전 모든 자산의 오디오 버퍼 로드 (믹스다운/재생 공용) */
  async ensureAllLoaded(project: Project): Promise<void> {
    await Promise.all(project.assets.filter((a) => a.audioWavPath).map((a) => this.loadAsset(a)))
  }

  /** fromT 부터 프로젝트의 모든 오디오를 스케줄하고 재생 시작 */
  async start(project: Project, fromT: number): Promise<void> {
    this.stop()
    await this.ctx.resume()
    await this.ensureAllLoaded(project)
    await this.ensureSfxLoaded()
    this.anchorCtxTime = this.ctx.currentTime + 0.03 // 스케줄 여유
    this.anchorT = fromT
    this._playing = true

    const triggers = collectSfxTriggers(project, SFX_BY_ID)
    const graph = scheduleProjectAudio(this.ctx, this.master, project, fromT, this.anchorCtxTime, (id) => this.buffers.get(id), {
      triggers,
      getBuffer: (id) => this.sfxBuffers.get(id)
    })
    this.active = graph.sources
    this.trackGains = graph.trackGains
    this.liveMaster = graph.master
  }

  /** 재생 중 마스터/트랙 볼륨 실시간 반영 (2.2.2) */
  applyLiveVolumes(project: Project): void {
    if (this.liveMaster) this.liveMaster.gain.value = project.settings.masterVolume
    for (const track of project.tracks) {
      const g = this.trackGains.get(track.id)
      if (g) g.gain.value = track.muted ? 0 : (track.volume ?? 1)
    }
  }

  stop(): void {
    const t = this.currentTime()
    for (const s of this.active) {
      try {
        s.node.stop()
      } catch {
        /* not started */
      }
      s.node.disconnect()
      s.clipGain.disconnect()
    }
    this.active = []
    for (const g of this.trackGains.values()) g.disconnect()
    this.trackGains.clear()
    this.liveMaster?.disconnect()
    this.liveMaster = null
    this._playing = false
    this.anchorT = t
  }

  seekTo(t: number): void {
    this.anchorT = t
  }
}

/** 파형 피크 (2.1.2): 버킷별 |max| — 클립 블록 렌더용 */
const peaksCache = new Map<string, Float32Array>()

export function computePeaks(assetId: string, buffer: AudioBuffer, buckets: number): Float32Array {
  const key = `${assetId}:${buckets}`
  const hit = peaksCache.get(key)
  if (hit) return hit
  const ch0 = buffer.getChannelData(0)
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0
  const out = new Float32Array(buckets)
  const per = Math.max(1, Math.floor(ch0.length / buckets))
  for (let b = 0; b < buckets; b++) {
    let peak = 0
    const start = b * per
    const end = Math.min(ch0.length, start + per)
    for (let i = start; i < end; i += 8) {
      const v = Math.max(Math.abs(ch0[i]), Math.abs(ch1[i]))
      if (v > peak) peak = v
    }
    out[b] = peak
  }
  peaksCache.set(key, out)
  return out
}
