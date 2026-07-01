/**
 * 재생 컨트롤러 (1.4) — 렌더 루프 + 시크 + A/V 동기화.
 *
 * 렌더 루프는 rAF 기반. (계획의 rVFC 는 <video> 전용 API 라 캔버스 합성 루프에는 rAF 가 맞다)
 * 클럭: 오디오 재생 중엔 AudioContext 기반 AudioEngine.currentTime() 이 마스터 (1.4.6),
 * 오디오가 전혀 없으면 performance.now 기반.
 */
import type { Project } from '@shared/model/types'
import { Compositor } from './compositor'
import { AudioEngine } from './audioEngine'
import { buildLayersAccurate, buildLayersPoll } from './scene'
import { projectDuration } from '@renderer/state/commands'
import { useEditor } from '@renderer/state/store'

export class PlaybackController {
  compositor: Compositor | null = null
  audio: AudioEngine | null = null
  private rafId = 0
  private lastPerf = 0
  private seekGen = 0

  attachCanvas(canvas: HTMLCanvasElement, width: number, height: number): void {
    this.compositor?.dispose()
    this.compositor = new Compositor(canvas, width, height)
    void this.seek(useEditor.getState().playhead)
  }

  private ensureAudio(project: Project): AudioEngine {
    if (!this.audio) this.audio = new AudioEngine(project.settings.sampleRate)
    return this.audio
  }

  /** 임포트 직후 오디오 버퍼 프리로드 (재생 시작 지연 방지) */
  preloadAudio(project: Project): void {
    const audio = this.ensureAudio(project)
    for (const asset of project.assets) {
      if (asset.audioWavPath) void audio.loadAsset(asset)
    }
  }

  async play(): Promise<void> {
    const s = useEditor.getState()
    if (s.playing) return
    const project = s.project
    const duration = projectDuration(project)
    let from = s.playhead
    if (from >= duration - 1e-3) from = 0
    const audio = this.ensureAudio(project)
    await audio.start(project, from)
    useEditor.getState().setPlaying(true)
    useEditor.getState().setPlayhead(from)
    this.lastPerf = performance.now()
    this.loop()
  }

  pause(): void {
    const s = useEditor.getState()
    if (!s.playing) return
    cancelAnimationFrame(this.rafId)
    this.audio?.stop()
    useEditor.getState().setPlaying(false)
    // 정지 시 프레임 정확 렌더로 스냅
    void this.seek(useEditor.getState().playhead)
  }

  async toggle(): Promise<void> {
    if (useEditor.getState().playing) this.pause()
    else await this.play()
  }

  /** 프레임 정확 시크 (1.4.4) — 일시정지 상태 기준 */
  async seek(t: number): Promise<void> {
    const gen = ++this.seekGen
    const s = useEditor.getState()
    const project = s.project
    const duration = projectDuration(project)
    const clamped = Math.min(Math.max(0, t), duration)
    useEditor.getState().setPlayhead(clamped)
    this.audio?.seekTo(clamped)

    if (s.playing) {
      // 재생 중 시크: 오디오 재시작으로 클럭 재앵커
      const audio = this.ensureAudio(project)
      await audio.start(project, clamped)
      return
    }
    if (!this.compositor) return
    const layers = await buildLayersAccurate(project, clamped)
    if (gen !== this.seekGen || !this.compositor) return
    this.compositor.render(layers, project.settings.backgroundColor)
  }

  /** 편집 조작 후 정지 화면 갱신 */
  refresh(): void {
    if (!useEditor.getState().playing) void this.seek(useEditor.getState().playhead)
  }

  private loop = (): void => {
    const s = useEditor.getState()
    if (!s.playing) return
    const project = s.project
    const duration = projectDuration(project)

    // 클럭 전진 (1.4.6): 오디오 재생 중이면 오디오 클럭, 아니면 perf 클럭
    let t: number
    if (this.audio && this.audio.playing) {
      t = this.audio.currentTime()
    } else {
      const now = performance.now()
      t = s.playhead + (now - this.lastPerf) / 1000
      this.lastPerf = now
    }

    if (t >= duration) {
      useEditor.getState().setPlayhead(duration)
      this.pause()
      return
    }
    useEditor.getState().setPlayhead(t)
    this.audio?.applyLiveVolumes(project)

    if (this.compositor) {
      const layers = buildLayersPoll(project, t)
      this.compositor.render(layers, project.settings.backgroundColor)
    }
    this.rafId = requestAnimationFrame(this.loop)
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId)
    this.audio?.stop()
    this.compositor?.dispose()
  }
}

/** 앱 전역 단일 인스턴스 */
export const playback = new PlaybackController()
