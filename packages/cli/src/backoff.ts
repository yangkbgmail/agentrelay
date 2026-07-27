// Rendering for `agentrelay backoff` — a preview of the retry backoff schedule
// a policy produces for *transient* failures (spawn error / non-zero exit that
// isn't a rate limit). Where `config show` / `config validate` expose the raw
// policy values (base / factor / cap / jitter / maxAttempts), this translates
// them into the concrete "attempt 1 → wait 1m, attempt 2 → wait 2m, …" sequence
// so a policy can be tuned before a failure ever happens. Pure functions
// (separate from the commander wiring) so the output is testable without a TTY.

import type { BackoffSchedule, RetryPolicy } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Shown when the policy allows no retries at all (`maxAttempts` is 1). */
export const NO_RETRY_MESSAGE =
  "This policy retries 0 times (maxAttempts is 1) — a transient failure is marked failed immediately.";

/**
 * One-line summary of the raw policy knobs, e.g.
 * `policy: max 5 attempts · base 1m 0s · ×2 · cap 1h 0m · jitter 20%`.
 * The jitter clause is only shown when jitter is active.
 */
export function formatPolicyLine(policy: RetryPolicy): string {
  const attempts = policy.maxAttempts > 0 ? `max ${policy.maxAttempts} attempts` : "unlimited attempts";
  const parts = [
    attempts,
    `base ${formatDurationMs(policy.baseDelayMs)}`,
    `×${policy.factor}`,
    `cap ${formatDurationMs(policy.maxDelayMs)}`,
  ];
  if (policy.jitter > 0) parts.push(`jitter ${Math.round(Math.min(1, policy.jitter) * 100)}%`);
  return parts.join(" · ");
}

/**
 * Human-friendly multi-line render of the backoff schedule. With jitter active,
 * each step and the total show a `[min – max]` range instead of a single value.
 * Pure: no I/O, no clock. `color` gates ANSI codes (TTY only).
 */
export function renderBackoff(schedule: BackoffSchedule, options: { color?: boolean } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [];
  lines.push(b("Retry backoff schedule") + d("  (transient failures — spawn error / non-zero exit)"));
  lines.push(d(`  policy: ${formatPolicyLine(schedule.policy)}`));
  lines.push("");

  if (schedule.steps.length === 0) {
    lines.push(`  ${NO_RETRY_MESSAGE}`);
    return lines.join("\n");
  }

  const jittered = schedule.totalLowMs !== undefined && schedule.totalHighMs !== undefined;
  for (const step of schedule.steps) {
    const wait =
      step.jitterLowMs !== undefined && step.jitterHighMs !== undefined
        ? `${formatDurationMs(step.jitterLowMs)} – ${formatDurationMs(step.jitterHighMs)}`
        : formatDurationMs(step.delayMs);
    const cap = step.capped ? d(" (capped)") : "";
    lines.push(`  attempt ${step.attempt} → wait ${wait}${cap}`);
  }

  // Where the sequence stops: a limited policy fails after the cap; an unlimited
  // (or explicitly over-sized) preview is only a window into an endless series.
  if (!schedule.unlimited && schedule.policy.maxAttempts > 0) {
    lines.push(d(`  (after attempt ${schedule.policy.maxAttempts} the job is marked failed)`));
  } else {
    lines.push(d("  (unlimited attempts — schedule continues, capped)"));
  }

  lines.push("");
  const total = jittered
    ? `~${formatDurationMs(schedule.totalLowMs ?? 0)} – ${formatDurationMs(schedule.totalHighMs ?? 0)}`
    : `~${formatDurationMs(schedule.totalMs)}`;
  lines.push(`  total wait across retries: ${total}`);

  return lines.join("\n");
}

/** Machine-readable form for `--json` (scripts/jq). Echoes the full schedule. */
export function renderBackoffJson(schedule: BackoffSchedule, generatedAt: string = new Date().toISOString()): string {
  return JSON.stringify({ generatedAt, schedule }, null, 2);
}
