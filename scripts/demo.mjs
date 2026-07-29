#!/usr/bin/env node
// @ts-nocheck
/**
 * AgentRelay — 재현 가능한 end-to-end 데모 / 스모크 테스트
 * ------------------------------------------------------------------
 * BACKLOG "최종 QA + 재현 가능한 데모 스크립트" 항목의 구현.
 *
 * 진짜 rate-limit(5시간 창)을 기다리지 않고도 릴레이의 전체 수명주기를
 * 몇 초 만에 재현한다:
 *
 *   1. rate-limit에 걸렸다가 리셋 후 성공하는 "가짜 에이전트"를 생성한다.
 *   2. `agentrelay run -- node fake-agent.mjs` 로 감싸 실행 → rate-limit 감지 →
 *      리셋 시각까지 job이 큐에 park 된다.
 *   3. `agentrelay status` 로 대기 중 job과 카운트다운을 보여준다.
 *   4. 리셋 시각이 지날 때까지 (몇 초) 기다린다.
 *   5. `agentrelay tick` 으로 스케줄러 한 패스를 돌려 job을 재개시킨다 →
 *      이번엔 가짜 에이전트가 성공하므로 job이 `completed` 로 마감된다.
 *   6. `agentrelay stats` 로 릴레이 효과(성공률·해결 시간)를 요약한다.
 *
 * 완전 격리: OS 임시 디렉터리에 전용 스토어(AGENTRELAY_STORE)를 두므로
 * 사용자의 실제 `~/.agentrelay/jobs.json` 은 건드리지 않고, 끝나면 지운다.
 *
 * QA 겸용: 마지막에 job이 실제로 `completed` 인지 확인하고, 아니면 비정상
 * 종료 코드로 끝나므로 CI/수동 스모크 테스트로도 쓸 수 있다.
 *
 * 사용법:
 *   pnpm build && node scripts/demo.mjs      # 또는  pnpm demo
 *
 * dist가 없으면 CLI 패키지만 자동 빌드한다.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const CLI_BIN = join(REPO, "packages", "cli", "dist", "bin.js");

// 리셋 창(초). 짧게 잡아 데모를 몇 초 안에 끝낸다.
const WINDOW_SECONDS = 3;
// tick 전에 리셋 시각을 확실히 넘기기 위한 여유(ms).
const SETTLE_MS = 1500;

// NO_COLOR 또는 non-TTY 로 파이프될 땐 ANSI 를 끄고 평문으로.
const USE_COLOR = !process.env.NO_COLOR && process.stdout.isTTY;
const paint = (code) => (s) => (USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : `${s}`);
const c = {
  bold: paint(1),
  dim: paint(2),
  green: paint(32),
  red: paint(31),
  cyan: paint(36),
};

let step = 0;
function section(title) {
  step += 1;
  console.log(`\n${c.bold(c.cyan(`[${step}] ${title}`))}`);
}

function sleep(ms) {
  // 데모용 동기 대기 — CPU 를 태우지 않는 blocking sleep.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** agentrelay CLI 를 격리 스토어로 실행하고, 출력을 흘려보내며 결과를 돌려준다. */
function relay(args, { store, quiet = false } = {}) {
  console.log(c.dim(`$ agentrelay ${args.join(" ")}`));
  const res = spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd: REPO,
    env: { ...process.env, AGENTRELAY_STORE: store, NO_COLOR: "1" },
    encoding: "utf8",
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (!quiet && out.trim()) {
    console.log(
      out
        .trimEnd()
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n")
    );
  }
  return { code: res.status ?? 0, out };
}

/** 임시 디렉터리에 "가짜 에이전트"를 생성한다.
 *  - 처음 호출: 리셋 시각(now + WINDOW)을 상태 파일에 기록하고 rate-limit 메시지 출력 → exit 1
 *  - 리셋 시각 이후 재호출: 성공 메시지 출력 → exit 0
 *  - 아직 리셋 전 재호출: 다시 rate-limit 메시지 출력 → exit 1
 */
function writeFakeAgent(dir) {
  const agentPath = join(dir, "fake-agent.mjs");
  const statePath = join(dir, "agent-state.json");
  const src = `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const STATE = ${JSON.stringify(statePath)};
const WINDOW_MS = ${WINDOW_SECONDS} * 1000;
let releaseAt;
if (existsSync(STATE)) {
  releaseAt = JSON.parse(readFileSync(STATE, "utf8")).releaseAt;
} else {
  releaseAt = Date.now() + WINDOW_MS;
  writeFileSync(STATE, JSON.stringify({ releaseAt }));
}
if (Date.now() >= releaseAt) {
  console.log("[fake-agent] ✔ 작업 재개 완료 — 변경분을 커밋했습니다.");
  process.exit(0);
}
const iso = new Date(releaseAt).toISOString();
console.error(
  "Claude usage limit reached. Your limit will reset at " + iso + ".\\n" +
    "resets at " + iso
);
process.exit(1);
`;
  writeFileSync(agentPath, src);
  return agentPath;
}

function parseJobs(out) {
  try {
    return JSON.parse(out).jobs ?? [];
  } catch {
    return [];
  }
}

function ensureBuilt() {
  if (existsSync(CLI_BIN)) return;
  console.log(c.dim("dist가 없어 CLI 패키지를 빌드합니다 (pnpm --filter @agentrelay/cli build)…"));
  const res = spawnSync("pnpm", ["--filter", "@agentrelay/cli", "build"], {
    cwd: REPO,
    stdio: "inherit",
    encoding: "utf8",
  });
  if (res.status !== 0 || !existsSync(CLI_BIN)) {
    console.error(c.red("빌드에 실패했습니다. 먼저 `pnpm build` 를 실행하세요."));
    process.exit(1);
  }
}

function main() {
  console.log(c.bold("AgentRelay 데모 — rate-limit 감지 → 자동 재개 전체 흐름"));
  ensureBuilt();

  const workdir = mkdtempSync(join(tmpdir(), "agentrelay-demo-"));
  const store = join(workdir, "jobs.json");
  let ok = false;
  try {
    const agent = writeFakeAgent(workdir);

    section("가짜 에이전트를 rate-limit 상태로 실행 (agentrelay run)");
    console.log(c.dim(`격리 스토어: ${store}`));
    relay(["run", "--tool", "claude-code", "--project", "demo", "--", process.execPath, agent], { store });

    section("큐 상태 확인 — job이 리셋까지 park 되어 있어야 함 (agentrelay status)");
    const queued = relay(["status", "--json"], { store, quiet: true });
    const jobs = parseJobs(queued.out);
    const job = jobs[0];
    if (!job) {
      throw new Error("rate-limit이 감지되지 않아 job이 큐에 들어가지 않았습니다.");
    }
    console.log(`  job ${c.bold(job.id.slice(0, 8))} · project=${job.project} · status=${c.cyan(job.status)}`);
    console.log(`  리셋 예정: ${job.resetAt}`);
    if (job.status !== "waiting_for_reset") {
      throw new Error(`예상 status=waiting_for_reset, 실제=${job.status}`);
    }

    section(`리셋 시각까지 대기 (~${WINDOW_SECONDS}s)`);
    console.log(c.dim("실제라면 최대 5시간; 데모에선 몇 초."));
    sleep(WINDOW_SECONDS * 1000 + SETTLE_MS);

    section("스케줄러 한 패스 실행 — job 재개 (agentrelay tick)");
    relay(["tick"], { store });

    section("최종 상태 확인 (agentrelay status)");
    const finalRes = relay(["status", "--json"], { store, quiet: true });
    const finalJob = parseJobs(finalRes.out)[0];
    console.log(
      `  job ${c.bold(finalJob.id.slice(0, 8))} · status=${
        finalJob.status === "completed" ? c.green(finalJob.status) : c.red(finalJob.status)
      } · attempts=${finalJob.attempts}`
    );

    section("릴레이 통계 요약 (agentrelay stats)");
    relay(["stats"], { store });

    ok = finalJob.status === "completed";
    console.log(
      `\n${ok ? c.green("✔ 데모 성공") : c.red("✗ 데모 실패")} — job 최종 상태: ${finalJob.status}`
    );
  } finally {
    rmSync(workdir, { recursive: true, force: true });
    console.log(c.dim(`임시 디렉터리 정리 완료: ${workdir}`));
  }

  process.exit(ok ? 0 : 1);
}

main();
