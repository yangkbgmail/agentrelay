// Rendering for `agentrelay backoff` — a preview of the retry backoff schedule
// the *resolved* policy (env vars + config file + defaults) produces for
// transient failures. `config show` lists the raw knobs (base / factor / cap /
// jitter / maxAttempts); this translates them into the concrete wait sequence a
// job would actually experience, so users can sanity-check tuning before a real
// failure. Kept as pure functions (separate from the commander wiring) so the
// output is testable without a TTY or a spawned scheduler.

import type { BackoffSchedule } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Compact human summary of the policy knobs behind the schedule. */
export function formatPolicyLine(schedule: BackoffSchedule): string {
  const { policy, unlimited } = schedule;
  const attempts = unlimited ? "unlimited attempts" : `max ${policy.maxAttempts} attempts`;
  const parts = [
    attempts,
    `base ${formatDurationMs(policy.baseDelayMs)}`,
    `×${policy.factor}`,
    `cap ${formatDurationMs(policy.maxDelayMs)}`,
  ];
  if (policy.jitter > 0) parts.push(`jitter ±${Math.round(policy.jitter * 100)}%`);
  return parts.join(" · ");
}

/**
 * Human-friendly multi-line block: the policy summary, one line per
 * between-attempt wait (with jitter bounds when jitter is on), and a total.
 * Pure: `color` gates ANSI codes (TTY only), no clock, no I/O.
 */
export function renderBackoff(schedule: BackoffSchedule, options: { color?: boolean } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  const { policy, unlimited, steps } = schedule;
  const hasJitter = policy.jitter > 0;

  const lines: string[] = [];
  lines.push(b("Retry backoff schedule") + d("  (transient failures — spawn error / non-zero exit)"));
  lines.push(d(`  policy: ${formatPolicyLine(schedule)}`));
  lines.push("");

  if (steps.length === 0) {
    // maxAttempts <= 1 (or --attempts 0): the first failure ends the job, so
    // there is never a backoff wait.
    lines.push(d("  No retries — the first failure marks the job failed."));
    return lines.join("\n");
  }

  // Align the "attempt N" labels so the arrows line up.
  const labelWidth = `attempt ${steps[steps.length - 1].attempt}`.length;
  for (const step of steps) {
    const label = `attempt ${step.attempt}`.padEnd(labelWidth);
    const wait = formatDurationMs(step.delayMs);
    const capNote = step.capped ? d(" (at cap)") : "";
    let range = "";
    if (hasJitter && step.maxDelayMs !== step.minDelayMs) {
      range = d(`  (${formatDurationMs(step.minDelayMs)} – ${formatDurationMs(step.maxDelayMs)})`);
    }
    lines.push(`  ${d(label)} → wait ${b(wait)}${capNote}${range}`);
  }

  if (!unlimited) {
    lines.push(d(`  (after attempt ${policy.maxAttempts} the job is marked failed)`));
  } else {
    lines.push(d(`  (unlimited attempts — showing the first ${steps.length})`));
  }

  lines.push("");
  let total = `  total wait across retries: ~${formatDurationMs(schedule.totalDelayMs)}`;
  if (hasJitter && schedule.totalMaxMs !== schedule.totalMinMs) {
    total += d(`  (${formatDurationMs(schedule.totalMinMs)} – ${formatDurationMs(schedule.totalMaxMs)} with jitter)`);
  }
  lines.push(total);

  return lines.join("\n");
}

/** Machine-readable form for `--json` (scripts/jq). Emits the full schedule. */
export function renderBackoffJson(schedule: BackoffSchedule): string {
  return JSON.stringify(schedule, null, 2);
}
