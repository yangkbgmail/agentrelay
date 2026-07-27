#!/usr/bin/env node
/**
 * AgentRelay — 재현 가능한 엔드투엔드 데모 (BACKLOG "최종 QA + 재현 가능한 데모 스크립트").
 *
 * 이 스크립트는 별도 준비물 없이 릴레이의 핵심 수명주기를 실제 CLI로 시연한다:
 *   run(레이트리밋 감지→큐잉) → status/next/show(대기 상태 확인) → tick(리셋 후 재개)
 *   → status/stats(완료 확인).
 *
 * 사용자의 실제 저장소(`~/.agentrelay/jobs.json`)는 절대 건드리지 않는다 — 매 실행마다
 * OS 임시 디렉터리에 격리된 스토어를 만들고, 끝나면 지운다. 네트워크·클라우드·발송 없음.
 *
 * 실행:  pnpm build && node scripts/demo.mjs
 *
 * 어떻게 "레이트리밋"을 재현하나?
 *   진짜 에이전트 대신, 상태 파일로 호출 횟수를 세는 가짜 에이전트를 쓴다. 첫 호출에서는
 *   Codex 스타일 레이트리밋 문구("Please try again in 2s.")를 출력해 릴레이가 잡을 큐잉하게
 *   만들고, 재개(두 번째 호출)에서는 성공 메시지를 출력해 잡이 completed 로 끝나게 한다.
 *
 * 종료 코드: 시연이 기대대로 흐르면 0, 어느 단계든 어긋나면 1(마지막에 "DEMO OK"/"DEMO FAIL").
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const CLI_BIN = join(REPO_ROOT, "packages", "cli", "dist", "bin.js");

// 리셋까지의 대기(초)와 데모가 tick 전에 잠드는 시간(ms). 대기보다 넉넉히 자서 CI 지연에도
// 잡이 확실히 due 가 되도록 한다.
const RESET_SECONDS = 2;
const SLEEP_BEFORE_TICK_MS = RESET_SECONDS * 1000 + 900;

function section(title) {
  console.log(`\n${"─".repeat(64)}\n▶ ${title}\n${"─".repeat(64)}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 임시 스토어를 대상으로 CLI 서브커맨드를 동기 실행. stdout/stderr/status 를 반환. */
function relay(store, args) {
  const res = spawnSync(process.execPath, [CLI_BIN, "--store", store, ...args], {
    encoding: "utf8",
  });
  if (res.error) throw res.error;
  return { status: res.status ?? 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** 조건이 거짓이면 데모를 실패로 종료. */
function assert(cond, message) {
  if (!cond) {
    console.error(`\n✗ 검증 실패: ${message}`);
    throw new Error(message);
  }
  console.log(`  ✓ ${message}`);
}

async function main() {
  if (!existsSync(CLI_BIN)) {
    console.error(
      `CLI 빌드 산출물을 찾을 수 없습니다: ${CLI_BIN}\n먼저 빌드하세요:  pnpm build`
    );
    process.exit(1);
  }

  const workdir = mkdtempSync(join(tmpdir(), "agentrelay-demo-"));
  const store = join(workdir, "jobs.json");
  const stateFile = join(workdir, "agent-calls.txt");
  const fakeAgent = join(workdir, "fake-agent.mjs");

  // 가짜 에이전트: 첫 호출은 레이트리밋 문구, 이후 호출은 성공.
  writeFileSync(
    fakeAgent,
    [
      "import { readFileSync, writeFileSync, existsSync } from 'node:fs';",
      "const stateFile = process.argv[2];",
      "const calls = existsSync(stateFile) ? Number(readFileSync(stateFile, 'utf8')) || 0 : 0;",
      "writeFileSync(stateFile, String(calls + 1));",
      "if (calls === 0) {",
      "  console.log('일하는 중... API 호출.');",
      "  console.log('Rate limit reached. Please try again in " + RESET_SECONDS + "s.');",
      "} else {",
      "  console.log('한도 리셋됨 — 작업 재개, 성공적으로 완료했습니다.');",
      "}",
    ].join("\n"),
    "utf8"
  );

  let failure = null;
  try {
    console.log("AgentRelay 데모 — 격리된 임시 스토어:", store);

    // 1) run: 가짜 에이전트를 감싸 실행 → 레이트리밋 감지 → 잡 큐잉.
    section("1) agentrelay run — 에이전트를 감싸 실행하고 레이트리밋을 감지");
    const runRes = relay(store, [
      "run",
      "--tool",
      "codex-cli",
      "--project",
      "demo",
      "--",
      process.execPath,
      fakeAgent,
      stateFile,
    ]);
    process.stdout.write(runRes.stdout);
    assert(/Rate limit detected/i.test(runRes.stdout), "run 이 레이트리밋을 감지해 잡을 큐잉했다");

    // 2) status --json: 큐 상태 확인 + 잡 id 확보.
    section("2) agentrelay status — 잡이 리셋 대기 상태로 큐에 들어갔다");
    const statusRes = relay(store, ["status", "--json"]);
    const snapshot = JSON.parse(statusRes.stdout);
    assert(Array.isArray(snapshot.jobs) && snapshot.jobs.length === 1, "스토어에 잡이 정확히 1개 있다");
    const job = snapshot.jobs[0];
    assert(job.status === "waiting_for_reset", `잡 상태가 waiting_for_reset 이다 (실제: ${job.status})`);
    assert(job.project === "demo", "프로젝트 라벨이 --project 로 지정한 'demo' 다");
    console.log(relay(store, ["status"]).stdout);

    // 3) next / show: 다음 재개 대상과 잡 상세.
    section("3) agentrelay next & show — 다음 재개 대상과 감지 출처");
    console.log(relay(store, ["next"]).stdout);
    console.log(relay(store, ["show", job.id.slice(0, 8)]).stdout);

    // 4) 리셋 시점까지 대기 후 tick — 스케줄러가 잡을 재개.
    section(`4) ${RESET_SECONDS}s 리셋 대기 후 agentrelay tick — 스케줄러가 잡을 재개`);
    console.log(`  ⏳ ${SLEEP_BEFORE_TICK_MS}ms 대기 중...`);
    await sleep(SLEEP_BEFORE_TICK_MS);
    const tickRes = relay(store, ["tick"]);
    process.stdout.write(tickRes.stdout);
    assert(/-> completed/.test(tickRes.stdout), "tick 이 잡을 재개해 completed 로 끝냈다");

    // 5) 최종 상태·통계.
    section("5) agentrelay status & stats — 최종 결과");
    const finalSnapshot = JSON.parse(relay(store, ["status", "--json"]).stdout);
    const finalJob = finalSnapshot.jobs[0];
    assert(finalJob.status === "completed", `최종 잡 상태가 completed 다 (실제: ${finalJob.status})`);
    const agentCalls = Number(readFileSync(stateFile, "utf8"));
    assert(agentCalls === 2, `가짜 에이전트가 정확히 2번 호출됐다(최초+재개) (실제: ${agentCalls})`);
    console.log(relay(store, ["stats"]).stdout);
  } catch (err) {
    failure = err;
  } finally {
    // 임시 스토어 정리 — 사용자 환경에 아무것도 남기지 않는다.
    try {
      rmSync(workdir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }

  if (failure) {
    console.error("\nDEMO FAIL —", failure.message);
    process.exit(1);
  }
  console.log("\n✅ DEMO OK — run → 감지 → 큐잉 → tick → 재개 → completed 전 과정이 통과했습니다.");
}

main().catch((err) => {
  console.error("\nDEMO FAIL —", err?.stack ?? err);
  process.exit(1);
});
