/**
 * VideoSource — 자산 하나의 WebCodecs 디코더 관리 (1.4.2~1.4.4, 내보내기 공용)
 *
 * 핵심 동작:
 * - getFrameAt(t): 프레임 정확 접근. 전진 접근이면 디코더 연속성 유지(연속 디코딩),
 *   후진/원거리 점프면 reset 후 target 직전 키프레임부터 디코딩 (정확 시크).
 * - 재생 시에는 pump(t) 로 논블로킹 디코딩 → displayFrame 에 최신 프레임 유지.
 * - VideoFrame 수명: 이 클래스가 소유. 새 프레임 도착 시 이전 프레임 close.
 */
import { demuxVideo, type DemuxedVideo } from './demux'

const MAX_DECODE_QUEUE = 24
/** B-프레임 리오더 여유: target 디코드 인덱스보다 이만큼 더 feed 해본 뒤 flush */
const REORDER_MARGIN = 16

export class VideoSource {
  readonly width: number
  readonly height: number
  readonly durationSec: number

  private demuxed: DemuxedVideo
  private decoder: VideoDecoder
  private nextFeedIdx = 0
  private configuredFromKey = false
  private outputQueue: VideoFrame[] = []
  private outputWaiters: Array<() => void> = []
  private current: VideoFrame | null = null
  /** 현재 프레임의 cts — 정수 µs. float 초와 섞어 비교하면 반올림 오차로 프레임 판정이 어긋난다 */
  private currentCtsUs = -1
  private mutex: Promise<unknown> = Promise.resolve()
  private seekGen = 0
  private pumping = false
  private disposed = false

  private constructor(demuxed: DemuxedVideo) {
    this.demuxed = demuxed
    this.width = demuxed.width
    this.height = demuxed.height
    this.durationSec = demuxed.durationSec
    this.decoder = this.createDecoder()
  }

  static async load(filePath: string): Promise<VideoSource> {
    const demuxed = await demuxVideo(filePath)
    const support = await VideoDecoder.isConfigSupported(demuxed.config)
    if (!support.supported) {
      // 호출자가 프록시 fallback (0.4) 경로로 전환한다
      throw new Error(`WebCodecs 미지원 코덱: ${demuxed.config.codec}`)
    }
    return new VideoSource(demuxed)
  }

  /** 재생 중 논블로킹 프레임 요청 — 최신 완료 프레임은 displayFrame 으로 읽는다 */
  pump(tSec: number): void {
    if (this.pumping || this.disposed) return
    this.pumping = true
    void this.getFrameAt(tSec)
      .catch(() => null)
      .finally(() => {
        this.pumping = false
      })
  }

  get displayFrame(): VideoFrame | null {
    return this.current
  }

  /**
   * 프레임 정확 접근. 반환 프레임의 소유권은 VideoSource 에 있다(호출자는 즉시 그려야 함).
   * 기본적으로 나중에 온 호출이 이전 호출을 중단시킨다(시크 연타 대응).
   * noAbort=true 는 중단 없이 끝까지 수행 (썸네일 등 일회성 스냅샷용).
   */
  async getFrameAt(tSec: number, opts?: { noAbort?: boolean }): Promise<VideoFrame | null> {
    const gen = opts?.noAbort ? null : ++this.seekGen
    const run = this.mutex.then(() => this.getFrameAtInner(tSec, gen))
    this.mutex = run.catch(() => null)
    return run
  }

  private async getFrameAtInner(tSec: number, gen: number | null): Promise<VideoFrame | null> {
    if (this.disposed) return null
    const po = this.demuxed.presentationOrder
    if (po.length === 0) return null

    // cts 이진 탐색: t 이하의 가장 큰 프레젠테이션 엔트리
    let lo = 0
    let hi = po.length - 1
    const t = Math.min(Math.max(tSec, po[0].cts), po[hi].cts)
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (po[mid].cts <= t + 1e-9) lo = mid
      else hi = mid - 1
    }
    const target = po[lo]
    // 정수 µs 도메인으로 통일: EncodedVideoChunk.timestamp = round(cts×1e6) 이므로
    // 같은 반올림을 거치면 디코더 출력 timestamp 와 정확히 일치한다.
    const targetUs = Math.round(target.cts * 1e6)

    // 이미 그 프레임을 들고 있으면 재사용
    if (this.current && this.currentCtsUs === targetUs) return this.current

    const keyIdx = this.keyframeBefore(target.decodeIdx)
    const movingForward =
      this.configuredFromKey && this.nextFeedIdx > keyIdx && targetUs > this.currentCtsUs && this.nextFeedIdx <= target.decodeIdx + REORDER_MARGIN + 1

    if (!movingForward) this.resetTo(keyIdx)

    // target 프레젠테이션 프레임이 나올 때까지 feed + drain
    let fedPastTarget = 0
    for (;;) {
      if (this.disposed || (gen !== null && gen !== this.seekGen)) return null

      const got = this.drainUpTo(targetUs)
      if (got) return got

      if (this.nextFeedIdx < this.demuxed.samples.length && fedPastTarget < REORDER_MARGIN) {
        await this.feedOne()
        if (this.nextFeedIdx > target.decodeIdx) fedPastTarget++
      } else {
        // 남은 출력 강제 방출. flush 후엔 키프레임부터 다시 feed 해야 하므로 연속성 해제.
        try {
          await this.decoder.flush()
        } catch {
          return null
        }
        this.configuredFromKey = false
        const got2 = this.drainUpTo(targetUs)
        return got2 ?? this.current
      }
    }
  }

  /** 출력 큐에서 targetUs(µs) 에 도달한 프레임을 찾는다. 지난 프레임은 close. */
  private drainUpTo(targetUs: number): VideoFrame | null {
    while (this.outputQueue.length > 0) {
      const frame = this.outputQueue[0]
      const ctsUs = frame.timestamp ?? 0
      if (ctsUs <= targetUs) {
        this.outputQueue.shift()
        this.setCurrent(frame, ctsUs)
        if (ctsUs === targetUs) return this.current
        continue
      }
      // 큐 앞이 target 을 지났다 — 현재 들고 있는 게 target 직전(=표시할) 프레임
      return this.currentCtsUs >= 0 && this.currentCtsUs <= targetUs ? this.current : null
    }
    return this.current && this.currentCtsUs === targetUs ? this.current : null
  }

  private setCurrent(frame: VideoFrame, ctsUs: number): void {
    if (this.current && this.current !== frame) this.current.close()
    this.current = frame
    this.currentCtsUs = ctsUs
  }

  private async feedOne(): Promise<void> {
    while (this.decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
      await new Promise<void>((resolvePromise) => this.outputWaiters.push(resolvePromise))
      if (this.disposed) return
    }
    const s = this.demuxed.samples[this.nextFeedIdx++]
    this.decoder.decode(
      new EncodedVideoChunk({
        type: s.isKey ? 'key' : 'delta',
        timestamp: Math.round(s.cts * 1e6),
        duration: Math.round(s.duration * 1e6),
        data: s.data as BufferSource
      })
    )
    // 출력이 생길 시간을 준다
    await new Promise<void>((resolvePromise) => {
      if (this.outputQueue.length > 0) resolvePromise()
      else setTimeout(resolvePromise, 0)
    })
  }

  private keyframeBefore(decodeIdx: number): number {
    for (let i = Math.min(decodeIdx, this.demuxed.samples.length - 1); i >= 0; i--) {
      if (this.demuxed.samples[i].isKey) return i
    }
    return 0
  }

  private resetTo(keyIdx: number): void {
    try {
      this.decoder.reset()
    } catch {
      this.decoder = this.createDecoder()
    }
    this.decoder.configure(this.demuxed.config)
    for (const f of this.outputQueue) f.close()
    this.outputQueue = []
    this.nextFeedIdx = keyIdx
    this.configuredFromKey = true
  }

  private createDecoder(): VideoDecoder {
    const decoder = new VideoDecoder({
      output: (frame) => {
        this.outputQueue.push(frame)
        const waiters = this.outputWaiters
        this.outputWaiters = []
        for (const w of waiters) w()
      },
      error: (e) => {
         
        console.error('[VideoDecoder]', e)
        const waiters = this.outputWaiters
        this.outputWaiters = []
        for (const w of waiters) w()
      }
    })
    decoder.configure(this.demuxed.config)
    this.configuredFromKey = false
    return decoder
  }

  dispose(): void {
    this.disposed = true
    this.seekGen++
    for (const f of this.outputQueue) f.close()
    this.outputQueue = []
    if (this.current) {
      this.current.close()
      this.current = null
    }
    try {
      this.decoder.close()
    } catch {
      /* already closed */
    }
    const waiters = this.outputWaiters
    this.outputWaiters = []
    for (const w of waiters) w()
  }
}

/** 자산 경로별 VideoSource / ImageBitmap 캐시 (LRU 상한 — 6.2.2) */
const videoSources = new Map<string, { promise: Promise<VideoSource>; lastUsed: number }>()
const imageBitmaps = new Map<string, Promise<ImageBitmap>>()
const MAX_SOURCES = 8

/**
 * instanceKey: 같은 파일의 두 구간이 동시에 필요할 때(전환 A/B) 별도 디코더 인스턴스를 만든다.
 */
export function getVideoSource(filePath: string, instanceKey?: string): Promise<VideoSource> {
  const key = instanceKey ? `${filePath}|${instanceKey}` : filePath
  let entry = videoSources.get(key)
  if (!entry) {
    // LRU 정리: 상한 초과 시 가장 오래 안 쓴 소스 dispose (샘플 데이터 메모리 회수)
    if (videoSources.size >= MAX_SOURCES) {
      const oldest = [...videoSources.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]
      if (oldest) {
        void oldest[1].promise.then((s) => s.dispose()).catch(() => {})
        videoSources.delete(oldest[0])
      }
    }
    const promise = VideoSource.load(filePath)
    promise.catch(() => videoSources.delete(key))
    entry = { promise, lastUsed: Date.now() }
    videoSources.set(key, entry)
  }
  entry.lastUsed = Date.now()
  return entry.promise
}

/** 자산 경로가 바뀌었을 때(재연결 등) 캐시 무효화 */
export function evictVideoSource(filePath: string): void {
  for (const [key, entry] of videoSources) {
    if (key === filePath || key.startsWith(`${filePath}|`)) {
      void entry.promise.then((s) => s.dispose()).catch(() => {})
      videoSources.delete(key)
    }
  }
}

export function getImageBitmap(filePath: string): Promise<ImageBitmap> {
  let p = imageBitmaps.get(filePath)
  if (!p) {
    p = fetch(`media://local${filePath.split('/').map(encodeURIComponent).join('/')}`)
      .then((r) => r.blob())
      .then((b) => createImageBitmap(b))
    p.catch(() => imageBitmaps.delete(filePath))
    imageBitmaps.set(filePath, p)
  }
  return p
}
