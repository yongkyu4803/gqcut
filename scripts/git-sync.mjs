#!/usr/bin/env node
/**
 * 프로젝트 실행(dev/start) 전 깃 최신화 점검 & 안전 업데이트.
 *
 * npm 이 predev/prestart 훅으로 자동 실행한다. 절대 실행을 막지 않는다 —
 * 오프라인·깃 없음·원격 없음 등 어떤 경우에도 종료 코드 0 으로 통과시켜 dev 가 그대로 뜬다.
 *
 * 동작:
 *   1. git fetch (조용히, 타임아웃)
 *   2. 로컬 HEAD 를 origin/<현재브랜치> 와 비교
 *   3. 뒤처져 있고(behind) 워킹트리가 깨끗하면 → git pull --ff-only 로 자동 업데이트
 *   4. 뒤처져 있지만 변경사항이 있으면 → 경고만(자동 pull 안 함)
 *   5. 앞서 있거나(ahead)·최신이면 → 상태만 알림
 *
 * 건너뛰기: SKIP_GIT_SYNC=1 환경변수 또는 CI 환경에서는 아무 것도 하지 않는다.
 */

import { execFileSync } from 'node:child_process'

const C = { dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', reset: '\x1b[0m' }
const tag = `${C.cyan}[git-sync]${C.reset}`

/** git 명령 실행 — 실패 시 null (예외로 흐름을 끊지 않는다) */
function git(args, { timeout = 10_000 } = {}) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout }).trim()
  } catch {
    return null
  }
}

function main() {
  if (process.env.SKIP_GIT_SYNC === '1' || process.env.CI) return

  // 깃 저장소인지 확인
  if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') return

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!branch || branch === 'HEAD') return // detached HEAD 등은 손대지 않음

  // 현재 브랜치에 업스트림이 설정돼 있는지 (origin/<branch> 존재 여부)
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  if (!upstream) return // 추적 브랜치 없음 → 조용히 통과

  // 원격 최신화 (오프라인이면 null → 로컬 캐시 기준으로만 비교)
  const fetched = git(['fetch', '--quiet'], { timeout: 15_000 })
  if (fetched === null) {
    console.log(`${tag} ${C.dim}원격 fetch 실패(오프라인?) — 실행은 계속합니다${C.reset}`)
    return
  }

  // behind / ahead 계산
  const counts = git(['rev-list', '--left-right', '--count', `${upstream}...HEAD`])
  if (!counts) return
  const [behind, ahead] = counts.split(/\s+/).map((n) => parseInt(n, 10))

  if (!behind) {
    if (ahead) console.log(`${tag} ${C.green}로컬이 원격보다 ${ahead}커밋 앞섬 — push 대기 중${C.reset}`)
    else console.log(`${tag} ${C.green}이미 최신 (${upstream})${C.reset}`)
    return
  }

  // behind > 0 : 업데이트 필요. 워킹트리가 깨끗할 때만 자동 pull.
  const dirty = git(['status', '--porcelain'])
  if (dirty) {
    console.log(
      `${tag} ${C.yellow}원격보다 ${behind}커밋 뒤처짐. 변경사항이 있어 자동 업데이트를 건너뜁니다.${C.reset}\n` +
        `${tag} ${C.dim}커밋/스태시 후 'git pull --ff-only' 하세요.${C.reset}`
    )
    return
  }

  console.log(`${tag} 원격보다 ${behind}커밋 뒤처짐 — git pull --ff-only 실행...`)
  const pulled = git(['pull', '--ff-only'], { timeout: 30_000 })
  if (pulled === null) {
    console.log(
      `${tag} ${C.yellow}자동 업데이트 실패(히스토리 분기 등). 수동 확인 필요 — 실행은 계속합니다.${C.reset}`
    )
    return
  }
  console.log(`${tag} ${C.green}업데이트 완료 → ${git(['rev-parse', '--short', 'HEAD'])}${C.reset}`)
}

main()
