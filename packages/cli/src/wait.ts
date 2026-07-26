// Rendering for `agentrelay wait <id>` — the machine-readable `--json` form of
// the final result. The human line is produced by `waitForJob` in commands.ts
// (it already knows the job/outcome); this keeps the JSON shape consistent with
// `next --json` / `show --json` and unit-testable without a store or a clock.

import type { JobScope, RelayJob, WaitBatchState, WaitOutcome } from "@agentrelay/core";

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
 * Machine-readable final result for `wait --all --json`. Mirrors
 * {@link renderWaitJson} but carries the aggregate batch state (how many jobs
 * completed/failed/cancelled/were still pending) instead of a single job, plus
 * the optional active scope so scripts can see what the wait covered.
 */
export function renderWaitBatchJson(
  result: { outcome: WaitOutcome; state: WaitBatchState; exitCode: number },
  storePath: string,
  scope: JobScope | null = null,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify(
    {
      storePath,
      generatedAt,
      outcome: result.outcome,
      exitCode: result.exitCode,
      scope: scope ?? undefined,
      batch: result.state,
    },
    null,
    2
  );
}
