#!/usr/bin/env node
/**
 * dev-plan.json 검증기 (의존성 없음)
 *
 * 1) 구조 검증: 필수 필드/타입/enum
 * 2) 논리 일관성 검증:
 *    - id 중복
 *    - status=done 인데 체크리스트 미완료
 *    - status=not_started 인데 체크리스트 일부 완료 (상태 갱신 누락)
 *
 * 사용법: node scripts/validate-plan.mjs
 * 종료 코드: 오류 없으면 0, 있으면 1
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAN_PATH = resolve(__dirname, "..", "dev-plan.json");

const VALID_STATUS = ["not_started", "in_progress", "verifying", "done", "blocked"];

const errors = [];
const warnings = [];
const err = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

let plan;
try {
  plan = JSON.parse(readFileSync(PLAN_PATH, "utf8"));
} catch (e) {
  console.error(`✗ dev-plan.json 파싱 실패: ${e.message}`);
  process.exit(1);
}

// ---- 구조 + 일관성 검증 -----------------------------------------------
if (!plan.meta) err("meta 누락");
if (!plan.techStack) err("techStack 누락");
if (!Array.isArray(plan.phases) || plan.phases.length === 0) err("phases 가 비어있음");

const seenIds = new Set();
const dupId = (id, where) => {
  if (seenIds.has(id)) err(`중복 id: ${id} (${where})`);
  seenIds.add(id);
};

for (const phase of plan.phases ?? []) {
  const where = phase.id ?? "(id 없는 phase)";
  if (!phase.id || !/^phase-\d+$/.test(phase.id)) err(`잘못된 phase id: ${where}`);
  dupId(phase.id, "phase");
  if (!phase.name) err(`${where}: name 누락`);
  if (!phase.goal) err(`${where}: goal 누락`);
  if (!VALID_STATUS.includes(phase.status)) err(`${where}: 잘못된 status '${phase.status}'`);
  if (!Array.isArray(phase.steps) || phase.steps.length === 0) err(`${where}: steps 비어있음`);

  for (const step of phase.steps ?? []) {
    const sw = `${where}/${step.id ?? "?"}`;
    if (!step.id || !/^\d+\.\d+$/.test(step.id)) err(`잘못된 step id: ${sw}`);
    dupId(step.id, "step");
    if (!step.name) err(`${sw}: name 누락`);
    if (!VALID_STATUS.includes(step.status)) err(`${sw}: 잘못된 status '${step.status}'`);
    if (!Array.isArray(step.checklist) || step.checklist.length === 0) err(`${sw}: checklist 비어있음`);

    const total = step.checklist?.length ?? 0;
    const done = step.checklist?.filter((i) => i.done).length ?? 0;

    for (const item of step.checklist ?? []) {
      if (!item.id) err(`${sw}: checklist 항목 id 누락`);
      if (typeof item.task !== "string" || !item.task) err(`${sw}/${item.id}: task 누락`);
      if (typeof item.done !== "boolean") err(`${sw}/${item.id}: done 은 boolean 이어야 함`);
    }

    // 검증 루프 존재 여부
    if (!step.verification) {
      err(`${sw}: verification 누락`);
    } else {
      if (!Array.isArray(step.verification.loop) || step.verification.loop.length === 0)
        err(`${sw}: verification.loop 비어있음`);
      if (!Array.isArray(step.verification.successCriteria) || step.verification.successCriteria.length === 0)
        err(`${sw}: verification.successCriteria 비어있음`);
    }

    // 상태 <-> 체크리스트 일관성
    if (step.status === "done" && done < total)
      warn(`${sw}: status=done 이지만 체크리스트 미완료 (${done}/${total})`);
    if (step.status === "not_started" && done > 0)
      warn(`${sw}: status=not_started 이지만 체크리스트 ${done}개 완료됨 → 상태 갱신 필요`);
    if (done === total && total > 0 && step.status !== "done" && step.status !== "verifying")
      warn(`${sw}: 체크리스트 전부 완료 → 검증(verifying) 또는 done 으로 전환 검토`);
  }
}

// ---- 출력 -------------------------------------------------------------
if (warnings.length) {
  console.log("\n⚠ 경고:");
  for (const w of warnings) console.log(`  - ${w}`);
}
if (errors.length) {
  console.log("\n✗ 오류:");
  for (const e of errors) console.log(`  - ${e}`);
  console.log(`\n검증 실패: 오류 ${errors.length}건, 경고 ${warnings.length}건\n`);
  process.exit(1);
}

console.log(`✔ dev-plan.json 검증 통과 (경고 ${warnings.length}건)\n`);
process.exit(0);
