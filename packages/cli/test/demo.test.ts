import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// scripts/demo.mjs 를 실제로 구동해, 빌드된 CLI가 run/status/stats/metrics/export/next/show/doctor
// 전 파이프라인을 격리 스토어에 대해 정상 실행하는지 검증하는 엔드투엔드 스모크. 데모 스크립트는
// 빌드 산출물(dist/bin.js·core dist)을 자식 프로세스로 돌리므로, CI에선 build 단계 뒤 test에서
// 산출물이 존재한다(로컬은 사전에 `pnpm build` 필요). 산출물이 없으면 이 테스트는 스킵한다.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const DEMO = join(REPO_ROOT, "scripts", "demo.mjs");
const CLI_BIN = join(REPO_ROOT, "packages", "cli", "dist", "bin.js");

const built = existsSync(CLI_BIN);

describe.skipIf(!built)("scripts/demo.mjs (end-to-end smoke)", () => {
  const run = spawnSync(process.execPath, [DEMO], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 60_000,
  });
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;

  it("exits 0 (every demoed command succeeded)", () => {
    expect(run.status, out).toBe(0);
  });

  it("drives the full command pipeline", () => {
    // 각 커맨드가 실제로 구동됐음을 섹션 표제로 확인.
    for (const marker of ["라이브 run", "status", "stats", "metrics", "export", "next", "show", "doctor"]) {
      expect(out).toContain(marker);
    }
  });

  it("live run detects a rate limit and parks the job with provenance", () => {
    // 감싼 커맨드가 뱉은 레이트리밋을 파서가 잡아 waiting_for_reset로 파킹하고,
    // show가 감지 출처(rate limit 섹션 + matched)를 렌더한다.
    expect(out).toContain("waiting_for_reset");
    expect(out).toContain("rate limit");
    expect(out).toContain("matched");
  });

  it("renders valid Prometheus exposition text", () => {
    expect(out).toContain("# TYPE agentrelay_jobs gauge");
    expect(out).toContain("agentrelay_success_rate");
  });

  it("completes with the success banner", () => {
    expect(out).toContain("데모 완료");
  });
});
