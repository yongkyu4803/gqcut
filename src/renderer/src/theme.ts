/**
 * UI 테마 (다크 / 라이트-베이지) — <html data-theme> 속성으로 전환, localStorage 에 저장.
 * CSS 변수(styles.css :root[data-theme='light'])가 실제 색을 담당한다.
 */
export type Theme = 'dark' | 'light'

const KEY = 'gqcut-theme'

export function getStoredTheme(): Theme {
  return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'
}

/** 테마 적용 + 저장. 다크는 기본이라 속성을 지워 :root 기본값을 쓴다. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'light') root.setAttribute('data-theme', 'light')
  else root.removeAttribute('data-theme')
  localStorage.setItem(KEY, theme)
}
