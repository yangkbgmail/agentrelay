// Rendering for `agentrelay drain` — the machine-readable `--json` form of the
// final result. The human line is produced by `drainQueue` in commands.ts (it
// already knows the snapshot/outcome); this keeps the JSON shape consistent
// with `wait --json` and unit-testable without a store or a clock.

import type { DrainOutcome, DrainSnapshot } from "@agentrelay/core";

/**
 * Machine-readable final result for `--json`: the aggregate outcome, the exit
 * code a script should branch on, and the last snapshot's per-disposition
 * counts.
 */
export function renderDrainJson(
  result: { outcome: DrainOutcome; snapshot: DrainSnapshot; exitCode: number },
  storePath: string,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify(
    {
      storePath,
      generatedAt,
      outcome: result.outcome,
      exitCode: result.exitCode,
      snapshot: result.snapshot,
    },
    null,
    2
  );
}
