/**
 * 시스템 폰트 목록 — 메인 프로세스(app:listFonts, font-list 패키지)에서 OS 폰트를 조회한다.
 * 결과는 세션 동안 캐시(매번 IPC/OS 조회를 반복하지 않음). 실패 시 빈 배열.
 */
export const GENERIC_FONT_FALLBACK = ['sans-serif', 'serif', 'monospace']

let cache: Promise<string[]> | null = null

export function listSystemFonts(): Promise<string[]> {
  if (!cache) cache = window.editor.listFonts().catch(() => [])
  return cache
}

/** 드롭다운 표시용 — font-list 가 공백 포함 이름에 붙인 따옴표를 라벨에서만 제거 */
export function displayFontName(fontFamily: string): string {
  return fontFamily.replace(/^"|"$/g, '')
}
