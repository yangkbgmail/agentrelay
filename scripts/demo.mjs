#!/usr/bin/env node
// AgentRelay — 재현 가능한 엔드투엔드 데모 / QA 스모크 (BACKLOG "최종 QA + 재현 가능한 데모 스크립트")
//
// 무엇: 격리된 임시 스토어에 대표적인 잡 집합을 심고, **실제로 빌드된 CLI**(`dist/bin.js`)를
//   run/status/stats/metrics/export/next/show/doctor 순으로 구동해 한 화면에서 전체 흐름을 보여준다.
//   목업이 아니라 실제 바이너리를 자식 프로세스로 돌리므로, 이 스크립트가 초록이면 그 자체가
//   전 커맨드 파이프라인의 통합 스모크 테스트가 된다(`packages/cli/test/demo.test.ts`가 이걸 실행).
//
// 왜: 사람이 `pnpm demo` 한 번으로 AgentRelay가 무엇을 하는지 눈으로 확인하고, CI가 커맨드들을
//   실제 스토어에 대해 함께 구동해 회귀를 잡게 하기 위함. 외부 네트워크/에이전트 호출은 전혀 없다
//   (라이브 `run`은 항상 존재하는 `node -e`를 감싸 즉시 완료시킨다).
//
// 어떻게: 스토어는 CLAUDE.md의 "중요한 결정"대로 JSON 파일. 임시 디렉터리를 만들고 끝나면 지운다.
//   `--json`/파이프 등 색상 안 나오는 경로만 사용하고, 각 커맨드는 비영-종료 시 즉시 실패한다.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const CLI_BIN = join(REPO_ROOT, "packages", "cli", "dist", "bin.js");
const CORE_ENTRY = join(REPO_ROOT, "packages", "core", "dist", "index.js");

// 색은 스크레이프/CI 로그에서 노이즈라 강제로 끈다.
const bold = (s) => (process.env.NO_COLOR ? s : `[1m${s}[0m`);
const dim = (s) => (process.env.NO_COLOR ? s : `[2m${s}[0m`);

function fail(message) {
  console.error(`\n[demo] ${message}`);
  process.exit(1);
}

/** 빌드 산출물이 있는지 먼저 확인 — 없으면 친절히 안내하고 종료. */
async function loadCore() {
  const { existsSync } = await import("node:fs");
  if (!existsSync(CLI_BIN) || !existsSync(CORE_ENTRY)) {
    fail(`빌드 산출물이 없습니다(${CLI_BIN}). 먼저 \`pnpm build\`를 실행하세요.`);
  }
  return import(pathToFileURL(CORE_ENTRY).href);
}

/** 빌드된 CLI를 자식 프로세스로 구동. 비영-종료면 데모 전체를 실패시킨다. */
function cli(storePath, args, { title, allowNonZero = false } = {}) {
  if (title) {
    console.log(`\n${bold(`▶ ${title}`)}`);
    console.log(dim(`  $ agentrelay ${args.join(" ")}`));
    console.log(dim("  " + "─".repeat(60)));
  }
  const res = spawnSync(process.execPath, [CLI_BIN, "--store", storePath, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  process.stdout.write(
    out
      .split("\n")
      .map((line) => (line ? `  ${line}` : line))
      .join("\n")
  );
  if (!out.endsWith("\n")) console.log("");
  if (!allowNonZero && res.status !== 0) {
    fail(`\`agentrelay ${args.join(" ")}\` 가 코드 ${res.status}로 종료했습니다.`);
  }
  return { stdout: res.stdout ?? "", status: res.status };
}

/**
 * 대표적인 잡 집합을 스토어에 심는다(라이브 run이 만든 잡에 더해). 실제 `RelayQueue` API를 쓰므로
 * 스토어 shape가 항상 최신 코드와 일치한다(직접 JSON을 쓰면 드리프트 위험). 프로젝트명/커맨드는
 * 고정이라 테스트가 안정된 문자열을 단언할 수 있다.
 */
function seed(core, storePath) {
  const { RelayQueue } = core;
  const queue = new RelayQueue(storePath);

  // 1) 정상 완료된 Claude Code 잡
  const done = queue.enqueue({
    project: "web-app",
    tool: "claude-code",
    command: ["claude", "-p", "리팩터링 계속"],
    cwd: "/repos/web-app",
  });
  queue.markCompleted(done.id, "done: 3 files changed");

  // 2) 실패한 잡(에러 메시지 포함)
  const broken = queue.enqueue({
    project: "api",
    tool: "claude-code",
    command: ["claude", "-p", "테스트 고쳐줘"],
    cwd: "/repos/api",
  });
  queue.markResuming(broken.id);
  queue.markFailed(broken.id, "exit code 1: build failed", "TypeError: cannot read ...");

  // 3) 큐에 대기 중인 Codex 잡
  queue.enqueue({
    project: "cli-tool",
    tool: "codex-cli",
    command: ["codex", "exec", "문서 작성"],
    cwd: "/repos/cli-tool",
  });

  queue.close();
}

/**
 * 스토어에서 rate-limit으로 파킹된(=`lastRateLimit` 출처가 있는) 잡의 id를 찾는다. 라이브 run이
 * 방금 감지·파킹한 잡을 `show` 데모의 대상으로 쓰기 위함. 없으면 null.
 */
function findParkedJobId(core, storePath) {
  const { RelayQueue } = core;
  const queue = new RelayQueue(storePath);
  const parked = queue.listAll().find((j) => j.status === "waiting_for_reset" && j.lastRateLimit);
  queue.close();
  return parked?.id ?? null;
}

async function main() {
  const core = await loadCore();
  const dir = mkdtempSync(join(tmpdir(), "agentrelay-demo-"));
  const storePath = join(dir, "jobs.json");

  try {
    console.log(bold("AgentRelay 데모 — 격리 스토어에서 전체 CLI 흐름을 시연합니다"));
    console.log(dim(`스토어: ${storePath}`));

    // (a) 실제 라이브 실행: AgentRelay의 핵심 가치를 증명한다 — 감싼 커맨드가 레이트리밋 메시지를
    //     내뱉으면 relay가 그 자리에서 감지→리셋 시각 파싱→잡을 큐에 올려 리셋 대기로 파킹한다.
    //     (`--tool claude-code`로 Claude 파서를 붙여 "reset at 5pm" 형식을 인식시킨다.)
    cli(
      storePath,
      [
        "run",
        "--tool",
        "claude-code",
        "--",
        process.execPath,
        "-e",
        "console.log('Approaching your usage limit. Your limit will reset at 5pm.')",
      ],
      { title: "라이브 run — 감싼 커맨드가 레이트리밋을 알리자 relay가 감지→리셋 대기로 파킹" }
    );

    // (b) 대표 잡 시드(완료/실패/큐) — 리포팅 화면을 풍부하게.
    seed(core, storePath);
    const parkedId = findParkedJobId(core, storePath);
    console.log(dim("\n[demo] 라이브 run이 파킹한 잡 1건 + 대표 잡 3건(완료·실패·큐)을 준비했습니다."));

    // (c) 리포팅/조회 커맨드를 차례로 시연.
    cli(storePath, ["status"], { title: "status — 전체 잡과 상태" });
    cli(storePath, ["status", "-s", "failed"], { title: "status -s failed — 상태 필터" });
    cli(storePath, ["stats"], { title: "stats — 집계 지표" });
    cli(storePath, ["metrics"], { title: "metrics — Prometheus 노출 형식" });
    cli(storePath, ["export", "--format", "md"], { title: "export --format md — 마크다운 테이블" });
    cli(storePath, ["next"], { title: "next — 다음에 재개될 잡" });
    if (parkedId) {
      cli(storePath, ["show", parkedId], {
        title: "show — 방금 라이브 감지된 잡의 리셋 출처(provenance): 왜 이 시각인가",
      });
    }
    // doctor는 시드 잡이 참조하는 툴(codex)이 PATH에 없고 데몬이 안 떠 있으면 진단상 경고/에러로
    // 코드 1을 반환한다 — 데모 환경에선 정상적인 결과이므로 비영-종료를 허용한다.
    cli(storePath, ["doctor"], { title: "doctor — 환경/스토어 진단", allowNonZero: true });

    console.log(bold("\n✔ 데모 완료 — 모든 커맨드가 정상 종료했습니다."));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  fail(err?.stack ?? String(err));
});
