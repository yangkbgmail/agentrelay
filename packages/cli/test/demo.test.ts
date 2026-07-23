import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// End-to-end smoke test: drive the reproducible demo (scripts/demo.mjs), which
// wraps a fake agent through the full relay loop (rate-limit → queue → tick →
// completed) against a throwaway store. The demo script exits non-zero unless
// the final state is exactly one completed job, so a green run here proves the
// whole CLI wiring works together, not just the units. Requires a prior
// `pnpm build` (CI builds before test); skipped otherwise so a bare `vitest`
// doesn't spuriously fail.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const demoScript = resolve(repoRoot, "scripts/demo.mjs");
const builtCli = resolve(repoRoot, "packages/cli/dist/bin.js");

function runDemo(): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [demoScript, "--quiet"], {
      cwd: repoRoot,
      // Turn the fake reset window down to keep the test fast; NO_COLOR keeps
      // output easy to assert on.
      env: { ...process.env, DEMO_RESET_SECONDS: "1", NO_COLOR: "1" },
    });
    let output = "";
    child.stdout.on("data", (d) => {
      output += d.toString();
    });
    child.stderr.on("data", (d) => {
      output += d.toString();
    });
    child.on("close", (code) => resolvePromise({ code: code ?? 0, output }));
  });
}

describe("demo script (end-to-end)", () => {
  const canRun = existsSync(builtCli) && existsSync(demoScript);

  it.skipIf(!canRun)(
    "runs the full relay loop to a single completed job",
    async () => {
      const { code, output } = await runDemo();
      expect(output).toContain("Demo passed");
      expect(code).toBe(0);
    },
    30_000
  );
});
