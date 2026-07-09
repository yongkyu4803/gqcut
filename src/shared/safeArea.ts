/**
 * 세이프 영역(자막/타이틀 안전선) 공용 기준 — 단일 출처(SSOT).
 * 프리뷰 가이드선(engine/guides.ts)과 자막 생성 위치(model/factory.subtitleBottomY)가
 * 반드시 같은 하단 기준선을 쓰도록 여기서 정의한다. (예전엔 guides 는 0.45H, 자막 생성은 0.4H 로
 * 어긋나 자막이 가이드선보다 위에 놓였다 — 이제 둘 다 이 함수를 참조한다.)
 */
export const SAFE_MARGIN_RATIO = 0.1

/**
 * 화면 하단 세이프 라인 (캔버스 중앙 기준, +아래 방향, 프로젝트 px).
 * 자막 블록의 "아래쪽 끝"을 이 라인에 맞추는 것이 표준 자막 위치.
 */
export function bottomSafeLineFromCenter(canvasHeight: number): number {
  return (canvasHeight / 2) * (1 - SAFE_MARGIN_RATIO)
}
