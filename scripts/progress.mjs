#!/usr/bin/env node
/**
 * dev-plan.json 진행률 추적 CLI
 *
 * 사용법:
 *   node scripts/progress.mjs              전체 진행률 요약
 *   node scripts/progress.mjs --phase 1    특정 페이즈 상세(체크리스트 포함)
 *   node scripts/progress.mjs --all        모든 페이즈의 체크리스트까지 상세
 *   node scripts/progress.mjs --next       다음에 해야 할 미완료 항목 표시
 *   node scripts/progress.mjs --json       기계가 읽을 수 있는 진행률 JSON 출력
 *
 * 종료 코드: 모든 체크리스트가 완료되면 0, 아니면 1 (CI 게이트로 활용 가능)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAN_PATH = resolve(__dirname, "..", "dev-plan.json");

// ---- 터미널 색상 (TTY 아닐 때는 비활성) --------------------------------
const useColor = process.stdout.isTTY;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c("2");
const bold = c("1");
const green = c("32");
const yellow = c("33");
const red = c("31");
const cyan = c("36");
const magenta = c("35");

const STATUS_STYLE = {
  not_started: dim,
  in_progress: yellow,
  verifying: cyan,
  done: green,
  blocked: red,
};

// ---- 인자 파싱 ---------------------------------------------------------
const args = process.argv.slice(2);
const flags = {
  phase: null,
  all: args.includes("--all"),
  next: args.includes("--next"),
  json: args.includes("--json"),
};
const phaseIdx = args.indexOf("--phase");
if (phaseIdx !== -1 && args[phaseIdx + 1]) flags.phase = args[phaseIdx + 1];

// ---- 계획 로드 ---------------------------------------------------------
let plan;
try {
  plan = JSON.parse(readFileSync(PLAN_PATH, "utf8"));
} catch (err) {
  console.error(red(`dev-plan.json 을 읽을 수 없습니다: ${PLAN_PATH}`));
  console.error(dim(String(err.message)));
  process.exit(2);
}

// ---- 집계 --------------------------------------------------------------
function tallyStep(step) {
  const total = step.checklist.length;
  const done = step.checklist.filter((i) => i.done).length;
  return { total, done, complete: total > 0 && done === total };
}

function tallyPhase(phase) {
  let total = 0;
  let done = 0;
  let stepsDone = 0;
  for (const step of phase.steps) {
    const t = tallyStep(step);
    total += t.total;
    done += t.done;
    if (t.complete) stepsDone += 1;
  }
  return { total, done, stepsTotal: phase.steps.length, stepsDone };
}

function tallyAll() {
  let total = 0;
  let done = 0;
  for (const phase of plan.phases) {
    const t = tallyPhase(phase);
    total += t.total;
    done += t.done;
  }
  return { total, done };
}

// ---- 렌더 유틸 ---------------------------------------------------------
function bar(done, total, width = 24) {
  if (total === 0) return dim("─".repeat(width)) + "  n/a";
  const ratio = done / total;
  const filled = Math.round(ratio * width);
  const pct = Math.round(ratio * 100);
  const fill = ratio === 1 ? green("█".repeat(filled)) : cyan("█".repeat(filled));
  const empty = dim("░".repeat(width - filled));
  const label = ratio === 1 ? green(`${pct}%`) : `${pct}%`;
  return `${fill}${empty} ${label.padStart(useColor ? 4 : 4)} (${done}/${total})`;
}

function statusTag(status) {
  const style = STATUS_STYLE[status] || ((s) => s);
  return style(`[${status}]`);
}

function checkbox(done) {
  return done ? green("✔") : dim("☐");
}

function phaseHeader(phase) {
  const t = tallyPhase(phase);
  const crit = phase.criticalPath ? magenta(" ★critical") : "";
  return `${bold(phase.id.toUpperCase())}  ${bold(phase.name)}${crit}
  ${bar(t.done, t.total)}   steps ${t.stepsDone}/${t.stepsTotal}   ${statusTag(phase.status)}
  ${dim(phase.goal)}`;
}

// ---- JSON 출력 모드 ----------------------------------------------------
if (flags.json) {
  const overall = tallyAll();
  const out = {
    project: plan.meta.project,
    overall: { ...overall, percent: overall.total ? Math.round((overall.done / overall.total) * 100) : 0 },
    phases: plan.phases.map((p) => {
      const t = tallyPhase(p);
      return {
        id: p.id,
        name: p.name,
        status: p.status,
        criticalPath: !!p.criticalPath,
        checklist: { done: t.done, total: t.total },
        steps: p.steps.map((s) => {
          const st = tallyStep(s);
          return { id: s.id, name: s.name, status: s.status, done: st.done, total: st.total, complete: st.complete };
        }),
      };
    }),
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(overall.total === overall.done ? 0 : 1);
}

// ---- --next: 다음 할 일 ------------------------------------------------
if (flags.next) {
  console.log(bold(`\n${plan.meta.project} — 다음 할 일\n`));
  let shown = 0;
  outer: for (const phase of plan.phases) {
    for (const step of phase.steps) {
      const pending = step.checklist.filter((i) => !i.done);
      if (pending.length === 0) continue;
      const risk = step.criticalRisk ? magenta(`  ⚠ ${step.criticalRisk}`) : "";
      console.log(`${cyan(phase.id)} ${bold(`${step.id} ${step.name}`)} ${statusTag(step.status)}${risk}`);
      for (const item of pending) {
        console.log(`   ${dim("☐")} ${item.id}  ${item.task}`);
      }
      console.log("");
      shown += 1;
      if (shown >= 2) break outer; // 현재+다음 단계 정도만
    }
  }
  if (shown === 0) console.log(green("  모든 체크리스트가 완료되었습니다. 🎉\n"));
  process.exit(0);
}

// ---- 상세 렌더 (--phase / --all) --------------------------------------
function renderStepDetail(step) {
  const t = tallyStep(step);
  const opt = step.optional ? dim(" (선택)") : "";
  const risk = step.criticalRisk ? magenta("  ⚠critical-risk") : "";
  console.log(`  ${bold(`${step.id} ${step.name}`)}${opt} ${statusTag(step.status)} ${dim(`${t.done}/${t.total}`)}${risk}`);
  for (const item of step.checklist) {
    console.log(`    ${checkbox(item.done)} ${dim(item.id)} ${item.task}`);
  }
  if (step.verification) {
    console.log(dim(`    ── 검증 성공 기준:`));
    for (const s of step.verification.successCriteria) {
      console.log(dim(`       • ${s}`));
    }
  }
  console.log("");
}

// ---- 메인 렌더 ---------------------------------------------------------
console.log(bold(`\n${plan.meta.project}  ${dim("v" + plan.meta.version)}\n`));

const targetPhases = flags.phase
  ? plan.phases.filter((p) => p.id === `phase-${flags.phase}` || p.id === flags.phase)
  : plan.phases;

if (flags.phase && targetPhases.length === 0) {
  console.error(red(`페이즈를 찾을 수 없습니다: ${flags.phase}`));
  process.exit(2);
}

for (const phase of targetPhases) {
  console.log(phaseHeader(phase));
  console.log("");
  if (flags.all || flags.phase) {
    for (const step of phase.steps) renderStepDetail(step);
  }
}

// ---- 전체 요약 ---------------------------------------------------------
const overall = tallyAll();
const pct = overall.total ? Math.round((overall.done / overall.total) * 100) : 0;
console.log(bold("─".repeat(48)));
console.log(`${bold("전체 진행률")}  ${bar(overall.done, overall.total, 30)}`);
const blocked = plan.phases.flatMap((p) => p.steps).filter((s) => s.status === "blocked");
if (blocked.length) {
  console.log(red(`\n⚠ blocked 단계 ${blocked.length}개: ${blocked.map((s) => s.id).join(", ")}`));
}
console.log("");
if (!flags.phase && !flags.all) {
  console.log(dim("자세히: node scripts/progress.mjs --phase 1   |   다음 할 일: --next\n"));
}

process.exit(overall.total === overall.done ? 0 : 1);
