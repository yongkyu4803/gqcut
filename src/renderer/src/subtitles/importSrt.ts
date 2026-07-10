/**
 * SRT 자막 가져오기 (feature-5) — 렌더러 오케스트레이션.
 * 파싱(shared/subtitles.parseSrt)은 순수, 여기서는 겹침 클램프 + 자막 클립 생성 + 스토어 배치(단일 undo)만 담당.
 * TransportBar(파일 다이얼로그)와 e2e 테스트 훅이 공유한다.
 */
import { createSubtitleClip, createTrack } from '@shared/model/factory'
import { parseSrt } from '@shared/subtitles'
import { useEditor } from '@renderer/state/store'
import { addSubtitleClips } from '@renderer/state/commands'

const MIN_DUR = 1 / 60 // 최소 자막 길이(1프레임@60fps)

/** SRT 문자열 → 자막 트랙 일괄 배치. 배치된 자막 수 반환(0이면 미배치). */
export function importSubtitlesFromSrt(content: string): number {
  const placements = parseSrt(content)
  // 겹치면 앞 자막 끝을 다음 시작으로 당겨 트랙 내 겹침 방지(불변식 1)
  for (let i = 0; i < placements.length - 1; i++) {
    placements[i].timelineEnd = Math.min(placements[i].timelineEnd, placements[i + 1].timelineStart)
  }
  const s = useEditor.getState()
  const height = s.project.settings.height
  const clips = placements
    .filter((pl) => pl.timelineEnd - pl.timelineStart >= MIN_DUR)
    .map((pl) => createSubtitleClip(pl.timelineStart, pl.timelineEnd, pl.text, height))
  if (clips.length === 0) return 0
  s.dispatch('자막 가져오기', (p) => addSubtitleClips(p, clips, createTrack('text')))
  return clips.length
}
