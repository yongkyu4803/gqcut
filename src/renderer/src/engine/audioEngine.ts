/**
 * 오디오 엔진 (1.4.5, 2.2) — Web Audio 그래프:
 *   클립 SourceNode → 클립 GainNode(볼륨/페이드) → 트랙 GainNode → 마스터 GainNode → Destination
 * AudioContext.currentTime 이 재생의 마스터 클럭 (1.4.6 A/V 싱크 기준).
 */
import type { MediaAsset, Project } from '@shared/model/types'
import { mediaUrl } from './demux'

interface ActiveSource {
  node: AudioBufferSourceNode
  clipGain: GainNode
}

export class AudioEngine {
  readonly ctx: AudioContext
  private master: GainNode
  private buffers = new Map<string, AudioBuffer>() // assetId → 디코딩된 오디오
  private loading = new Map<string, Promise<AudioBuffer | null>>()
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

  /** fromT 부터 프로젝트의 모든 오디오를 스케줄하고 재생 시작 */
  async start(project: Project, fromT: number): Promise<void> {
    this.stop()
    await this.ctx.resume()
    this.anchorCtxTime = this.ctx.currentTime + 0.03 // 스케줄 여유
    this.anchorT = fromT
    this._playing = true
    this.master.gain.value = project.settings.masterVolume

    for (const track of project.tracks) {
      if (track.kind === 'text' || track.muted) continue
      const trackGain = this.ctx.createGain()
      trackGain.gain.value = track.volume ?? 1
      trackGain.connect(this.master)
      this.trackGains.set(track.id, trackGain)

      for (const clip of track.clips) {
        if (clip.timelineEnd <= fromT + 1e-6) continue
        const asset = clip.assetId ? project.assets.find((a) => a.id === clip.assetId) : undefined
        if (!asset) continue
        const buffer = this.buffers.get(asset.id) ?? (await this.loadAsset(asset))
        if (!buffer) continue

        const speed = clip.speed ?? 1
        const startT = Math.max(clip.timelineStart, fromT)
        const when = this.anchorCtxTime + (startT - fromT)
        const offset = (clip.sourceIn ?? 0) + (startT - clip.timelineStart) * speed
        const durationSrc = (clip.timelineEnd - startT) * speed

        const node = this.ctx.createBufferSource()
        node.buffer = buffer
        node.playbackRate.value = speed

        const clipGain = this.ctx.createGain()
        this.scheduleClipGain(clipGain, clip.volume ?? 1, clip.fadeIn ?? 0, clip.fadeOut ?? 0, clip.timelineStart, clip.timelineEnd, fromT)

        node.connect(clipGain)
        clipGain.connect(trackGain)
        node.start(when, Math.max(0, offset), Math.max(0.001, durationSrc))
        this.active.push({ node, clipGain })
      }
    }
  }

  /** 페이드 인/아웃 automation (2.2.3) — 타임라인 시각을 ctx 시각으로 매핑해 램프 */
  private scheduleClipGain(
    gain: GainNode,
    volume: number,
    fadeIn: number,
    fadeOut: number,
    clipStart: number,
    clipEnd: number,
    fromT: number
  ): void {
    const toCtx = (t: number): number => this.anchorCtxTime + (t - fromT)
    const g = gain.gain
    const volAt = (t: number): number => {
      let v = volume
      if (fadeIn > 0 && t < clipStart + fadeIn) v *= Math.max(0, (t - clipStart) / fadeIn)
      if (fadeOut > 0 && t > clipEnd - fadeOut) v *= Math.max(0, (clipEnd - t) / fadeOut)
      return v
    }
    const startT = Math.max(clipStart, fromT)
    g.setValueAtTime(volAt(startT), Math.max(this.ctx.currentTime, toCtx(startT)))
    if (fadeIn > 0 && clipStart + fadeIn > startT) g.linearRampToValueAtTime(volume, toCtx(clipStart + fadeIn))
    if (fadeOut > 0 && clipEnd - fadeOut >= startT) {
      g.setValueAtTime(volume, toCtx(Math.max(startT, clipEnd - fadeOut)))
      g.linearRampToValueAtTime(0, toCtx(clipEnd))
    }
  }

  /** 재생 중 마스터/트랙 볼륨 실시간 반영 (2.2.2) */
  applyLiveVolumes(project: Project): void {
    this.master.gain.value = project.settings.masterVolume
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
