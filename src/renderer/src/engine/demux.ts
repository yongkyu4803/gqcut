/**
 * MP4 디먹스 (0.3.2) — mp4box.js 로 비디오 트랙의 인코딩 샘플과 디코더 설정을 추출한다.
 * media:// 프로토콜로 스트리밍 fetch → mp4box appendBuffer.
 *
 * 메모리: 샘플 데이터를 전부 보관한다(랜덤 시크용). 장편 소스 대응은 Phase 6.2 캐시 정책에서 개선.
 */
import { createFile, DataStream, type MP4ArrayBuffer, type MP4File, type MP4Sample } from 'mp4box'

export interface VideoSample {
  /** 프레젠테이션 시각 (초) */
  cts: number
  dts: number
  duration: number
  isKey: boolean
  data: Uint8Array
}

export interface DemuxedVideo {
  config: VideoDecoderConfig
  /** 디코드 순서(dts) 그대로 */
  samples: VideoSample[]
  /** cts 오름차순 → 디코드 인덱스 매핑 */
  presentationOrder: Array<{ cts: number; duration: number; decodeIdx: number }>
  width: number
  height: number
  durationSec: number
}

/**
 * filePath 를 쿼리 파라미터로 통째로 인코딩한다 — 세그먼트 단위(split('/'))로 나누면
 * Windows 경로("C:\Users\...")가 백슬래시라 전혀 분리되지 않고 URL host 로 삼켜져
 * pathname 이 비어버리는 버그가 있었다(ERR_FILE_NOT_FOUND 반복 발생 원인).
 */
export function mediaUrl(filePath: string): string {
  return `media://local/?p=${encodeURIComponent(filePath)}`
}

/** avcC/hvcC 등 코덱 설정 박스를 VideoDecoderConfig.description 으로 직렬화 */
function extractDescription(file: MP4File, trackId: number): Uint8Array | undefined {
  const trak = file.getTrackById(trackId)
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C
    if (box) {
      const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN)
      box.write(stream)
      return new Uint8Array(stream.buffer, 8) // 박스 헤더(size+type) 8바이트 제거
    }
  }
  return undefined
}

export async function demuxVideo(filePath: string): Promise<DemuxedVideo> {
  const file = createFile()

  const result = await new Promise<DemuxedVideo>((resolvePromise, reject) => {
    let collected: VideoSample[] = []
    let totalSamples = 0
    let track: { id: number; codec: string; timescale: number; width: number; height: number; durationSec: number } | null =
      null
    let settled = false

    const finish = (): void => {
      if (settled || !track) return
      settled = true
      file.stop()
      const samples = collected
      const presentationOrder = samples
        .map((s, decodeIdx) => ({ cts: s.cts, duration: s.duration, decodeIdx }))
        .sort((a, b) => a.cts - b.cts)
      const description = extractDescription(file, track.id)
      resolvePromise({
        config: { codec: track.codec, ...(description ? { description: description as BufferSource } : {}) },
        samples,
        presentationOrder,
        width: track.width,
        height: track.height,
        durationSec: track.durationSec
      })
    }

    file.onError = (e) => {
      if (!settled) {
        settled = true
        reject(new Error(`demux 실패: ${e}`))
      }
    }

    file.onReady = (info) => {
      const v = info.videoTracks[0]
      if (!v) {
        settled = true
        reject(new Error('비디오 트랙이 없습니다'))
        return
      }
      track = {
        id: v.id,
        codec: v.codec,
        timescale: v.timescale,
        width: v.video?.width ?? v.track_width,
        height: v.video?.height ?? v.track_height,
        durationSec: v.duration / v.timescale
      }
      totalSamples = v.nb_samples
      file.setExtractionOptions(v.id, null, { nbSamples: 1000 })
      file.start()
    }

    file.onSamples = (_trackId, _user, samples: MP4Sample[]) => {
      for (const s of samples) {
        collected.push({
          cts: s.cts / s.timescale,
          dts: s.dts / s.timescale,
          duration: s.duration / s.timescale,
          isKey: s.is_sync,
          // mp4box 내부 버퍼 재사용 대비 복사
          data: new Uint8Array(s.data)
        })
      }
      if (collected.length >= totalSamples) finish()
    }

    void (async () => {
      try {
        const res = await fetch(mediaUrl(filePath))
        if (!res.ok || !res.body) throw new Error(`파일을 읽을 수 없습니다 (${res.status})`)
        const reader = res.body.getReader()
        let offset = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          const buf = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as MP4ArrayBuffer
          buf.fileStart = offset
          offset += value.byteLength
          file.appendBuffer(buf)
          if (settled) {
            void reader.cancel()
            break
          }
        }
        file.flush()
        // moov 는 읽었지만 샘플 수가 명시보다 적게 온 경우 그대로 마감
        finish()
        if (!settled) {
          settled = true
          reject(new Error('MP4 파싱 실패: 비디오 트랙 정보를 찾지 못했습니다'))
        }
      } catch (e) {
        if (!settled) {
          settled = true
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      }
    })()
  })

  return result
}
