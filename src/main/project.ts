/**
 * 프로젝트 파일 관리 (6.1) — 저장/열기 시 미디어 경로 처리 + 자동저장/크래시 복구.
 *
 * 경로 규칙 (6.1.3):
 * - 저장: 자산 경로를 프로젝트 파일 기준 상대경로로 변환 (이식성). 프록시/wav 캐시 경로는
 *   재생성 가능하므로 그대로 두되, 로드 시 없으면 버린다.
 * - 로드: 상대경로를 절대경로로 복원, 존재하지 않는 원본은 status='missing' (재연결 UI 대상).
 */
import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

interface AssetLike {
  path: string
  proxyPath?: string
  perfProxyPath?: string
  audioWavPath?: string
  status: string
}

interface ProjectLike {
  assets: AssetLike[]
}

/** 저장용: 자산 경로 상대화 */
export function relativizeProject(json: string, projectPath: string): string {
  const proj = JSON.parse(json) as ProjectLike
  const base = dirname(projectPath)
  for (const asset of proj.assets) {
    if (isAbsolute(asset.path)) {
      const rel = relative(base, asset.path)
      // 다른 볼륨/드라이브로 나가면(rel 이 여전히 절대경로) 절대경로 유지
      if (!isAbsolute(rel)) asset.path = rel
    }
  }
  return JSON.stringify(proj, null, 2)
}

/** 로드용: 상대경로 복원 + 누락 감지 + 사라진 캐시 경로 정리 */
export function resolveProject(json: string, projectPath: string): string {
  const proj = JSON.parse(json) as ProjectLike
  const base = dirname(projectPath)
  for (const asset of proj.assets) {
    if (!isAbsolute(asset.path)) asset.path = resolve(base, asset.path)
    asset.status = existsSync(asset.path) ? 'ok' : 'missing'
    for (const key of ['proxyPath', 'perfProxyPath', 'audioWavPath'] as const) {
      const p = asset[key]
      if (p && !existsSync(p)) delete asset[key]
    }
  }
  return JSON.stringify(proj)
}

export async function saveProjectTo(path: string, json: string): Promise<void> {
  await writeFile(path, relativizeProject(json, path), 'utf8')
}

export async function openProjectFrom(path: string): Promise<string> {
  const raw = await readFile(path, 'utf8')
  return resolveProject(raw, path)
}

// ── 자동저장 / 크래시 복구 (6.1.2) ──────────────────────
function autosaveDir(): string {
  const dir = join(app.getPath('userData'), 'autosave')
  mkdirSync(dir, { recursive: true })
  return dir
}

const AUTOSAVE_FILE = 'last.gqproj.autosave'
const AUTOSAVE_META = 'last.meta.json'

export async function writeAutosave(json: string, originalPath: string | null): Promise<void> {
  const dir = autosaveDir()
  await writeFile(join(dir, AUTOSAVE_FILE), json, 'utf8')
  await writeFile(join(dir, AUTOSAVE_META), JSON.stringify({ savedAt: new Date().toISOString(), originalPath }), 'utf8')
}

export async function checkAutosave(): Promise<{ json: string; savedAt: string; originalPath: string | null } | null> {
  const dir = autosaveDir()
  const file = join(dir, AUTOSAVE_FILE)
  if (!existsSync(file)) return null
  try {
    const json = await readFile(file, 'utf8')
    const meta = JSON.parse(await readFile(join(dir, AUTOSAVE_META), 'utf8')) as { savedAt: string; originalPath: string | null }
    // 자산 경로는 절대경로로 저장되므로 누락 감지만 수행
    const resolved = resolveProject(json, meta.originalPath ?? file)
    return { json: resolved, savedAt: meta.savedAt, originalPath: meta.originalPath }
  } catch {
    return null
  }
}

export async function clearAutosave(): Promise<void> {
  const dir = autosaveDir()
  await rm(join(dir, AUTOSAVE_FILE), { force: true })
  await rm(join(dir, AUTOSAVE_META), { force: true })
}
