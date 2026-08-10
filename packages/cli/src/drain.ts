// Rendering + messaging for `agentrelay drain` — block until the whole queue is
// caught up, then report how it settled. Where `wait <id>` follows one job,
// `drain` follows the queue: it's the blocking companion to `eta` (which only
// reports *when* the queue will catch up). Kept as pure functions (separate from
// the polling loop in commands.ts) so the output is testable without a store, a
// clock, or a spawned process.

import type { DrainOutcome, DrainSnapshot } from "@agentrelay/core";

/**
 * One-line human summary of a settled (or timed-out) drain. `active` is only
 * non-zero on a timeout — the reason the queue never fully drained.
 */
export function drainMessage(outcome: DrainOutcome, snapshot: DrainSnapshot): string {
  const terminal = snapshot.completed + snapshot.failed + snapshot.cancelled;
  const parts: string[] = [];
  if (snapshot.completed > 0) parts.push(`${snapshot.completed} completed`);
  if (snapshot.failed > 0) parts.push(`${snapshot.failed} failed`);
  if (snapshot.cancelled > 0) parts.push(`${snapshot.cancelled} cancelled`);
  const breakdown = parts.length > 0 ? ` (${parts.join(", ")})` : "";

  switch (outcome) {
    case "drained":
      if (snapshot.total === 0) return "queue is empty — nothing to drain";
      return `queue drained: ${terminal} job${terminal === 1 ? "" : "s"} settled${breakdown}`;
    case "failed":
      return `queue drained but ${snapshot.failed} job${snapshot.failed === 1 ? "" : "s"} failed${breakdown}`;
    case "timeout":
      return `timed out with ${snapshot.active} job${snapshot.active === 1 ? "" : "s"} still active${breakdown}`;
  }
}

/**
 * Machine-readable final result for `--json` (scripts/jq): the outcome, the exit
 * code a script should branch on, and the final queue snapshot. Matches the
 * envelope of `wait --json` / `eta --json` (storePath + generatedAt).
 */
export function renderDrainJson(
  result: { outcome?: DrainOutcome; snapshot: DrainSnapshot; exitCode: number },
  storePath: string,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify(
    {
      storePath,
      generatedAt,
      outcome: result.outcome ?? null,
      exitCode: result.exitCode,
      snapshot: result.snapshot,
    },
    null,
    2
  );
}
