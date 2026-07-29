// Rendering helpers for `agentrelay resets` — a 24-hour histogram of when the
// queue's rate limits actually reset, built from the reset instant persisted on
// each job (detection provenance, falling back to the live resetAt). Kept as
// pure functions here, separate from the commander wiring in cli.ts, so the
// exact output is unit-testable without a store or a clock.

import type { ResetClockSummary } from "@agentrelay/core";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Shown when the store (or scoped subset) has no jobs at all. */
export const NO_JOBS_MESSAGE = "No jobs yet. Run `agentrelay run -- <your agent command>` to get started.";

/** Shown when a `--status`/`--tool`/`--project` scope matches nothing. */
export const NO_SCOPE_MATCH_MESSAGE = "No jobs match the current filter.";

/** Shown when jobs exist but none carry a usable reset instant yet. */
export const NO_RESETS_MESSAGE = "No rate-limit resets recorded on any job yet.";

/** Max width (chars) of a full-scale bar in the hour histogram. */
const BAR_WIDTH = 24;

/** A proportional bar `count/max` scaled to {@link BAR_WIDTH}; ≥1 for any nonzero count. */
function bar(count: number, max: number): string {
  if (max <= 0 || count <= 0) return "";
  const filled = Math.max(1, Math.round((count / max) * BAR_WIDTH));
  return "█".repeat(filled);
}

/** Zero-pad an hour into the `HH:00` label the rows use. */
function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/**
 * Renders the reset-clock summary as a multi-line block: a header, then one row
 * per hour of day (0–23) with its count and a proportional bar, and a footer
 * calling out the peak hour. Pure: no I/O, no clock. `color` gates ANSI codes
 * (TTY only). A `scopeNote` is echoed once at the top when a filter is active.
 *
 * Every one of the 24 hours is printed even when empty, so the daily shape —
 * quiet stretches included — is visible at a glance.
 */
export function renderResetClock(
  summary: ResetClockSummary,
  options: { color?: boolean; scopeNote?: string } = {}
): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [];
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));

  if (summary.total === 0) {
    lines.push(options.scopeNote ? NO_SCOPE_MATCH_MESSAGE : NO_JOBS_MESSAGE);
    return lines.join("\n");
  }
  if (summary.withReset === 0) {
    lines.push(NO_RESETS_MESSAGE);
    lines.push(d(`  ${summary.total} job(s) tracked, 0 with a recorded reset time`));
    return lines.join("\n");
  }

  const tz = summary.timeZone === "utc" ? "UTC" : "local time";
  lines.push(
    b(`${summary.withReset} reset(s) by hour of day (${tz})`) +
      d(` (of ${summary.total} job(s); ${summary.withoutReset} without a reset time)`)
  );
  lines.push("");

  const maxCount = summary.buckets.reduce((m, bkt) => Math.max(m, bkt.count), 0);
  for (const bkt of summary.buckets) {
    const label = hourLabel(bkt.hour);
    const count = String(bkt.count).padStart(3);
    // Empty hours show a dimmed marker so the daily rhythm stays readable.
    const graphic = bkt.count > 0 ? bar(bkt.count, maxCount) : d("·");
    lines.push(`  ${label}  ${count}  ${graphic}`);
  }

  if (summary.peakHour !== null) {
    lines.push("");
    lines.push(d(`peak: ${hourLabel(summary.peakHour)} ${tz}`));
  }

  return lines.join("\n");
}

/**
 * Machine-readable form of `agentrelay resets`, mirroring the `renderPatternsJson`
 * envelope: the resolved store path, when it was generated, the optional active
 * scope, and the full summary. Pure: `generatedAt` is injected, never read from
 * an ambient clock here.
 */
export function renderResetClockJson(payload: {
  storePath: string;
  generatedAt: string;
  scope?: Record<string, unknown>;
  summary: ResetClockSummary;
}): string {
  return JSON.stringify(payload, null, 2);
}
