// Rendering for `agentrelay wait <id>` — the machine-readable `--json` form of
// the final result. The human line is produced by `waitForJob` in commands.ts
// (it already knows the job/outcome); this keeps the JSON shape consistent with
// `next --json` / `show --json` and unit-testable without a store or a clock.

import type { RelayJob, WaitOutcome } from "@agentrelay/core";
import type { WaitAllResult } from "./commands.js";

/**
 * Machine-readable final result for `--json`. `outcome` is null only when the
 * id never resolved (an error the CLI reports separately); otherwise it carries
 * the terminal outcome, the exit code a script should branch on, and the last
 * job snapshot seen.
 */
export function renderWaitJson(
  result: { outcome?: WaitOutcome; job: RelayJob | null; exitCode: number },
  storePath: string,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify(
    {
      storePath,
      generatedAt,
      outcome: result.outcome ?? null,
      exitCode: result.exitCode,
      job: result.job,
    },
    null,
    2
  );
}

/**
 * Machine-readable final result for `wait --all --json`. Mirrors the per-job
 * shape but at the queue level: the aggregate `outcome`, the exit code to
 * branch on, `total` terminal jobs the outcome covered, and `remaining` active
 * jobs (non-zero only on a timeout).
 */
export function renderWaitAllJson(
  result: WaitAllResult,
  storePath: string,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify(
    {
      storePath,
      generatedAt,
      outcome: result.outcome,
      exitCode: result.exitCode,
      total: result.total,
      remaining: result.remaining,
    },
    null,
    2
  );
}
