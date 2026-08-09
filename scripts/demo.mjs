#!/usr/bin/env node
// AgentRelay — 재현 가능한 엔드투엔드 데모 & 스모크 QA.
//
// 무엇을 보여주나:
//   1. `agentrelay run -- <agent>` 로 에이전트 CLI를 감싸 실행한다.
//   2. 에이전트가 rate-limit 메시지를 내뱉으면 파서가 이를 감지하고 리셋 시각을
//      추출해 잡을 큐에 넣는다(`waiting_for_reset`).
//   3. 리셋 시각이 지나면 `agentrelay tick`(데몬의 1회 패스)이 **같은 명령을
//      다시 실행**해 작업을 자동 재개하고, 이번엔 성공하므로 `completed` 로 마감한다.
//   4. `status`/`stats` 로 릴레이 효과(성공률 100%)를 확인한다.
//
// 왜 이런 구조인가: 실제 rate-limit을 기다리지 않고도 전체 파서→큐→스케줄러→재개
// 경로를 로컬에서 몇 초 만에 재현하려고, 첫 실행에서만 rate-limit을 흉내 내고
// 재개 실행에서는 성공하는 상태 기반 "가짜 에이전트"를 심는다. 스케줄러가 잡의
// `command` 를 그대로 재실행한다는 사실(packages/core/src/scheduler.ts) 위에 서 있다.
//
// 이 스크립트는 데모이자 스모크 테스트다 — 마지막에 최종 상태를 검증하고, 기대와
// 다르면 0이 아닌 종료 코드로 끝나므로 로컬/CI 프리플라이트 게이트로도 쓸 수 있다.
//
// 사용법:
//   node scripts/demo.mjs [--reset <초>] [--keep] [--quiet]
//     --reset <초>  가짜 rate-limit의 리셋까지 초(기본 4). 더 빠른 데모는 2~3.
//     --keep        끝나도 임시 스토어/작업공간을 지우지 않고 경로를 출력.
//     --quiet       단계별 설명 없이 명령 출력만 흘려보냄(CI 친화).

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const CLI_ENTRY = join(REPO_ROOT, "packages", "cli", "dist", "bin.js");

// ---- 인자 파싱 -------------------------------------------------------------
const argv = process.argv.slice(2);
let resetSeconds = 4;
let keep = false;
let quiet = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--reset") {
    const n = Number(argv[++i]);
    if (!Number.isFinite(n) || n <= 0) fail(`--reset 값이 잘못됨: "${argv[i]}". 양의 초를 주세요.`);
    resetSeconds = n;
  } else if (a === "--keep") {
    keep = true;
  } else if (a === "--quiet") {
    quiet = true;
  } else if (a === "-h" || a === "--help") {
    console.log("사용법: node scripts/demo.mjs [--reset <초>] [--keep] [--quiet]");
    process.exit(0);
  } else {
    fail(`알 수 없는 인자: "${a}". --help 참고.`);
  }
}

// ---- 유틸 ------------------------------------------------------------------
const BOLD = quiet ? "" : "\x1b[1m";
const DIM = quiet ? "" : "\x1b[2m";
const GREEN = quiet ? "" : "\x1b[32m";
const RED = quiet ? "" : "\x1b[31m";
const RESET = quiet ? "" : "\x1b[0m";

let stepNo = 0;
function step(title) {
  if (quiet) return;
  stepNo += 1;
  console.log(`\n${BOLD}▶ ${stepNo}. ${title}${RESET}`);
}
function note(msg) {
  if (!quiet) console.log(`${DIM}${msg}${RESET}`);
}
function fail(msg) {
  console.error(`${RED}[demo] ✗ ${msg}${RESET}`);
  process.exit(1);
}

/**
 * 빌드된 CLI를 동기로 실행하고 결과를 돌려준다. `echo`는 실행 명령을 보여주고,
 * `silent`는 (내부 `status --json` 스냅샷처럼) 사람이 볼 필요 없는 출력을 숨긴다.
 */
function cli(args, { echo = true, silent = false, allowNonZero = false } = {}) {
  if (echo && !quiet) console.log(`${DIM}$ agentrelay ${args.join(" ")}${RESET}`);
  const res = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (res.error) fail(`CLI 실행 실패: ${res.error.message}`);
  if (res.stdout && !quiet && !silent) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (!allowNonZero && res.status !== 0) fail(`agentrelay ${args.join(" ")} 가 exit ${res.status} 로 실패.`);
  return res;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 사전 점검: CLI 빌드 확인(없으면 빌드) --------------------------------
if (!existsSync(CLI_ENTRY)) {
  note(`빌드 산출물이 없어 먼저 빌드합니다 (${CLI_ENTRY} 부재).`);
  const build = spawnSync("pnpm", ["-r", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
  if (build.status !== 0 || !existsSync(CLI_ENTRY)) {
    fail("`pnpm -r build` 가 실패했거나 CLI 산출물이 생성되지 않았습니다. 루트에서 `pnpm install && pnpm build` 후 다시 시도하세요.");
  }
}

// ---- 격리된 작업공간 + 가짜 에이전트 --------------------------------------
const workdir = mkdtempSync(join(tmpdir(), "agentrelay-demo-"));
const store = join(workdir, "jobs.json");
const counterFile = join(workdir, "attempts.count");
const agentPath = join(workdir, "fake-agent.mjs");

// 상태 기반 가짜 에이전트: 첫 호출은 rate-limit을 흉내 내고(exit 1), 재개 호출은
// 성공한다(exit 0). 리셋 시각은 지금+resetSeconds 의 ISO 타임스탬프로, 파서의
// "resets at <ISO>" 패턴이 잡는다.
const agentSource = `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const counter = ${JSON.stringify(counterFile)};
const n = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) || 0 : 0) + 1;
writeFileSync(counter, String(n));
if (n === 1) {
  const resetAt = new Date(Date.now() + ${resetSeconds} * 1000).toISOString();
  console.log("[fake-agent] 작업을 시작합니다…");
  console.log("Claude usage limit reached. Your limit resets at " + resetAt + ".");
  process.exit(1);
} else {
  console.log("[fake-agent] rate limit이 풀렸습니다. 재개하여 작업을 완료했습니다. (attempt " + n + ")");
  process.exit(0);
}
`;
writeFileSync(agentPath, agentSource);

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (keep) {
    console.log(`\n${DIM}--keep: 작업공간을 보존합니다 → ${workdir}${RESET}`);
    return;
  }
  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

/** status --json 에서 잡 배열을 읽어온다. */
function jobsSnapshot() {
  const res = cli(["--store", store, "status", "--json"], { echo: false, silent: true });
  try {
    const parsed = JSON.parse(res.stdout);
    return Array.isArray(parsed.jobs) ? parsed.jobs : [];
  } catch (err) {
    fail(`status --json 파싱 실패: ${err.message}`);
  }
}

// ===========================================================================
async function main() {
  if (!quiet) {
    console.log(`${BOLD}AgentRelay 엔드투엔드 데모${RESET}`);
    note(`격리 스토어: ${store}`);
    note(`가짜 에이전트: ${agentPath} (리셋 ${resetSeconds}s)`);
  }

  step("에이전트를 감싸 실행 — rate-limit을 감지하고 큐에 넣는다");
  note("실제 `claude -p \"...\"` 자리에 rate-limit을 흉내 내는 가짜 에이전트를 둡니다.");
  const runRes = cli(
    ["--store", store, "run", "--project", "demo-app", "--", process.execPath, agentPath],
    { allowNonZero: true },
  );
  if (!/Rate limit detected/i.test(runRes.stdout)) {
    fail("run 출력에서 'Rate limit detected'를 찾지 못했습니다 — 파서가 감지하지 못함.");
  }

  step("큐 상태 확인 — 잡이 waiting_for_reset 으로 대기 중");
  cli(["--store", store, "status"]);
  const afterRun = jobsSnapshot();
  if (afterRun.length !== 1) fail(`잡 1개를 기대했으나 ${afterRun.length}개.`);
  if (afterRun[0].status !== "waiting_for_reset") {
    fail(`잡 상태가 waiting_for_reset 이어야 하는데 "${afterRun[0].status}".`);
  }

  step("다음 재개 대상 — 리셋까지 카운트다운");
  cli(["--store", store, "next"]);

  step(`리셋을 기다립니다 (${resetSeconds + 1}s)…`);
  await sleep((resetSeconds + 1) * 1000);

  step("스케줄러 1회 패스 — 같은 명령을 재실행해 자동 재개");
  note("데몬을 상시 띄우는 대신 `tick`으로 한 번만 폴링합니다(cron/Routines와 동일).");
  const tickRes = cli(["--store", store, "tick"]);
  if (!/-> completed/.test(tickRes.stdout)) {
    fail("tick 출력에서 '-> completed'를 찾지 못했습니다 — 재개가 성공으로 마감되지 않음.");
  }

  step("최종 상태 — 잡이 completed");
  cli(["--store", store, "status"]);

  step("릴레이 통계 — 성공률 100%");
  cli(["--store", store, "stats"]);

  // ---- 스모크 검증 ---------------------------------------------------------
  const finalJobs = jobsSnapshot();
  if (finalJobs.length !== 1) fail(`최종 잡 1개를 기대했으나 ${finalJobs.length}개.`);
  if (finalJobs[0].status !== "completed") {
    fail(`최종 잡 상태가 completed 여야 하는데 "${finalJobs[0].status}".`);
  }

  console.log(`\n${GREEN}${BOLD}✓ 데모 성공${RESET} — run → 감지 → 큐 → tick → 재개 → completed 전 경로 확인.`);
  if (!quiet) {
    note("직접 만져보려면 `--keep`로 스토어를 남기고 `agentrelay --store <path> show <id>` 등을 실행하세요.");
  }
}

main().catch((err) => fail(err?.stack || String(err)));
