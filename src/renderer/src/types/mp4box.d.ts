declare module 'mp4box' {
  export interface MP4MediaTrack {
    id: number
    codec: string
    nb_samples: number
    timescale: number
    duration: number
    movie_timescale: number
    movie_duration: number
    track_width: number
    track_height: number
    video?: { width: number; height: number }
    audio?: { sample_rate: number; channel_count: number }
    type: string
  }

  export interface MP4Info {
    duration: number
    timescale: number
    videoTracks: MP4MediaTrack[]
    audioTracks: MP4MediaTrack[]
  }

  export interface MP4Sample {
    number: number
    track_id: number
    timescale: number
    is_sync: boolean
    cts: number
    dts: number
    duration: number
    size: number
    data: Uint8Array
  }

  export interface MP4ArrayBuffer extends ArrayBuffer {
    fileStart: number
  }

  export interface MP4File {
    onReady?: (info: MP4Info) => void
    onError?: (e: string) => void
    onSamples?: (trackId: number, user: unknown, samples: MP4Sample[]) => void
    appendBuffer(data: MP4ArrayBuffer): number
    setExtractionOptions(trackId: number, user?: unknown, options?: { nbSamples?: number; rapAlignement?: boolean }): void
    start(): void
    stop(): void
    flush(): void
    getTrackById(trackId: number): {
      mdia: { minf: { stbl: { stsd: { entries: Array<Record<string, { write(stream: DataStream): void } | undefined>> } } } }
    }
  }

  export class DataStream {
    static BIG_ENDIAN: boolean
    static LITTLE_ENDIAN: boolean
    constructor(arrayBuffer?: ArrayBuffer, byteOffset?: number, endianness?: boolean)
    buffer: ArrayBuffer
  }

  export function createFile(): MP4File
}
