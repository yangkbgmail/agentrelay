import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// End-to-end regression for the reproducible demo (scripts/demo.sh), which is
// the MVP's "runnable, self-verifying walkthrough" deliverable (SPEC §3 QA).
// The script drives the *built* CLI through the whole value loop —
// run (rate-limit detected → queued) → tick (auto-resume → completed) — against
// an isolated temp store, and prints `DEMO_RESULT=ok` only when the job actually
// reaches `completed`. Running it here means any regression that breaks the core
// relay loop (parser, scheduler resume, store, or the CLI wiring between them)
// fails a test, not just a hand-run demo.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const DEMO_SCRIPT = resolve(REPO_ROOT, "scripts", "demo.sh");
const CLI_BIN = resolve(REPO_ROOT, "packages", "cli", "dist", "bin.js");

// The demo shells out to the built CLI; in CI `build` runs before `test`, so
// dist/bin.js exists. When someone runs the CLI tests without building first,
// skip rather than fail on a missing artifact unrelated to this test's subject.
const canRun = existsSync(DEMO_SCRIPT) && existsSync(CLI_BIN);

describe.runIf(canRun)("scripts/demo.sh (end-to-end relay loop)", () => {
  it("queues a rate-limited job and auto-resumes it to completion", () => {
    const output = execFileSync("bash", [DEMO_SCRIPT], {
      encoding: "utf8",
      // Keep the simulated reset short so the test is fast but still exercises
      // the real waiting_for_reset → tick → completed transition.
      env: { ...process.env, AGENTRELAY_DEMO_RESET_SECONDS: "1", NO_COLOR: "1" },
      timeout: 30000,
    });

    // The relay loop's observable milestones, in order.
    expect(output).toContain("Rate limit detected for Codex CLI");
    expect(output).toContain("waiting_for_reset");
    expect(output).toContain("-> completed");
    // The script only prints this sentinel when the job's final status is
    // exactly `completed`, so it doubles as the pass/fail assertion.
    expect(output).toContain("DEMO_RESULT=ok");
  }, 30000);
});
