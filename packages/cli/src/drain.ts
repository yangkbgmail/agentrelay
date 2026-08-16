// Rendering for `agentrelay drain` — the machine-readable `--json` form of the
// final result, plus a small helper phrasing the still-draining progress line.
// The polling loop and human status lines live in `drainQueue` (commands.ts);
// this keeps the JSON shape consistent with `wait --json` / `eta --json` and
// unit-testable without a store or a clock.

import type { DrainOutcome, DrainProgress } from "@agentrelay/core";

/**
 * Human-friendly "still in flight" summary, e.g. "3 active: 2 waiting, 1
 * resuming". Only the non-zero buckets are listed; when they somehow all read
 * zero (should not happen for a still-draining progress) it falls back to the
 * bare active count. Pure — no clock, no color.
 */
export function formatDrainProgress(progress: DrainProgress): string {
  const parts: string[] = [];
  if (progress.queued > 0) parts.push(`${progress.queued} queued`);
  if (progress.waiting > 0) parts.push(`${progress.waiting} waiting`);
  if (progress.resuming > 0) parts.push(`${progress.resuming} resuming`);
  const plural = progress.active === 1 ? "job" : "jobs";
  const head = `${progress.active} active ${plural}`;
  return parts.length > 0 ? `${head}: ${parts.join(", ")}` : head;
}

/**
 * Machine-readable final result for `--json` (scripts/jq): the outcome, the exit
 * code a script should branch on, and the last progress snapshot seen. Matches
 * the envelope of `wait --json` / `eta --json`.
 */
export function renderDrainJson(
  result: { outcome: DrainOutcome; progress: DrainProgress; exitCode: number },
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
