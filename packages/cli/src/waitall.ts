// Rendering for `agentrelay waitall` — the machine-readable `--json` form of the
// final batch result. The human line is produced by `waitAllForJobs` in
// commands.ts (it already knows the outcome/progress); this keeps the JSON shape
// consistent with `wait --json` and unit-testable without a store or a clock.

import type { WaitAllOutcome, WaitAllProgress } from "@agentrelay/core";

/**
 * Machine-readable final result for `--json`: the batch outcome, the exit code a
 * script should branch on, and the settled/active tally so a caller can report
 * how the fan-out ended without re-reading the store.
 */
export function renderWaitAllJson(
  result: { outcome: WaitAllOutcome; progress: WaitAllProgress; exitCode: number },
  storePath: string,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify(
    {
      storePath,
      generatedAt,
      outcome: result.outcome,
      exitCode: result.exitCode,
      progress: result.progress,
    },
    null,
    2
  );
}
