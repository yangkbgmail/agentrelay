// Rendering for `agentrelay drain` — the machine-readable `--json` form of the
// final result. The human line is produced by `drainQueue` in commands.ts (it
// already knows the outcome/state); this keeps the JSON shape consistent with
// `wait --json` / `next --json` and unit-testable without a store or a clock.

import type { DrainOutcome, DrainState } from "@agentrelay/core";

/**
 * Machine-readable final result for `--json`: the terminal outcome, the exit
 * code a script should branch on, and the last queue snapshot (active/terminal/
 * failed counts) seen.
 */
export function renderDrainJson(
  result: { outcome: DrainOutcome; state: DrainState; exitCode: number },
  storePath: string,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify(
    {
      storePath,
      generatedAt,
      outcome: result.outcome,
      exitCode: result.exitCode,
      state: result.state,
    },
    null,
    2
  );
}
