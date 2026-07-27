import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// scripts/demo.mjs 를 실제 빌드된 CLI로 끝까지 돌려, 릴레이 수명주기 회귀를 지킨다.
// (BACKLOG: "최종 QA + 재현 가능한 데모 스크립트".) 데모는 격리된 임시 스토어만 쓰므로
// 사용자/CI 환경에 아무것도 남기지 않는다.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", ".."); // test -> cli -> packages -> repo root
const DEMO_SCRIPT = join(REPO_ROOT, "scripts", "demo.mjs");
const CLI_BIN = join(REPO_ROOT, "packages", "cli", "dist", "bin.js");

describe("scripts/demo.mjs (end-to-end)", () => {
  it("runs the full relay lifecycle: run -> detect -> queue -> tick -> resume -> completed", () => {
    // CI(그리고 로컬 `pnpm build && pnpm test`)는 테스트 전에 빌드하므로 dist 가 존재한다.
    // 없으면 조용히 스킵하지 말고 명확히 실패시켜, 빌드 누락을 놓치지 않는다.
    expect(existsSync(CLI_BIN), `CLI not built at ${CLI_BIN}; run \`pnpm build\` first`).toBe(true);

    const out = execFileSync(process.execPath, [DEMO_SCRIPT], {
      encoding: "utf8",
      timeout: 30_000,
    });

    // 데모가 스스로 검증하고 성공 시 "DEMO OK" 를 찍는다.
    expect(out).toContain("DEMO OK");
    expect(out).toContain("-> completed");
    expect(out).not.toContain("DEMO FAIL");
  }, 30_000);
});
