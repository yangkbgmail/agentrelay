// Rendering helpers for `agentrelay heatmap` — an hour-of-day histogram of when
// jobs were queued (i.e. when rate limits were detected). Distinct from
// `stats --trend` (which counts jobs per calendar day): this folds every day
// together into 24 hour-of-day buckets so the *daily rhythm* of rate limiting
// stands out. Kept as pure functions here, separate from the commander wiring
// in cli.ts, so the exact output is unit-testable without a store or a clock.

import type { HourlyActivity } from "@agentrelay/core";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Width, in block characters, of the busiest hour's bar. */
const BAR_WIDTH = 24;

/** Shown when the store (or scoped subset) has no jobs at all. */
export const NO_HEATMAP_MESSAGE = "No jobs yet. Run `agentrelay run -- <your agent command>` to get started.";

/** Shown when a `--status`/`--tool`/`--project`/`--since`/`--until` scope matches nothing. */
export const NO_SCOPE_MATCH_MESSAGE = "No jobs match the current filter.";

/** Formats a UTC offset in minutes as a label like "UTC", "UTC+09:00", "UTC-07:00". */
export function formatOffsetLabel(offsetMinutes: number): string {
  if (offsetMinutes === 0) return "UTC";
  const sign = offsetMinutes > 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${hh}:${mm}`;
}

/**
 * Renders the hour-of-day distribution as a 24-row bar chart, one row per hour
 * (00–23) with a bar scaled to the busiest hour, the raw count, and its share of
 * all counted jobs. Pure: no I/O, no clock. `color` gates ANSI codes (TTY only);
 * a `scopeNote` is echoed once at the top when a filter is active.
 */
export function renderHeatmap(activity: HourlyActivity, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [];
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));

  if (activity.total === 0) {
    lines.push(options.scopeNote ? NO_SCOPE_MATCH_MESSAGE : NO_HEATMAP_MESSAGE);
    return lines.join("\n");
  }

  const tz = formatOffsetLabel(activity.offsetMinutes);
  lines.push(b("activity by hour of day") + d(` (jobs created, ${tz})`));

  if (activity.counted === 0) {
    // Everything was skipped (no parseable createdAt) — say so plainly instead
    // of drawing 24 empty bars.
    lines.push(d(`  no jobs with a usable timestamp (${activity.skipped} skipped)`));
    return lines.join("\n");
  }

  lines.push("");
  const max = activity.peakCount;
  for (const { hour, count } of activity.hours) {
    const label = `${String(hour).padStart(2, "0")}:00`;
    // Scale each bar to the busiest hour; guarantee at least one block for any
    // non-zero hour so small counts don't vanish next to a spike. A zero hour
    // shows a single baseline dot.
    const filled = max === 0 || count === 0 ? 0 : Math.max(1, Math.round((count / max) * BAR_WIDTH));
    const plain = count === 0 ? "·" : "█".repeat(filled);
    const padded = plain.padEnd(BAR_WIDTH);
    const bar = count === 0 && color ? padded.replace("·", d("·")) : padded;
    const pct = activity.counted > 0 ? Math.round((count / activity.counted) * 100) : 0;
    const share = count === 0 ? "" : d(` ${pct}%`);
    const peakMark = hour === activity.peakHour ? d(" ← peak") : "";
    lines.push(`  ${d(label)}  ${bar} ${String(count).padStart(4)}${share}${peakMark}`);
  }

  const footerParts = [`${activity.counted} job(s) over 24h`];
  if (activity.peakHour !== null) {
    footerParts.push(`busiest ${String(activity.peakHour).padStart(2, "0")}:00 (${activity.peakCount})`);
  }
  if (activity.skipped > 0) footerParts.push(`${activity.skipped} skipped (no timestamp)`);
  lines.push(d(`  ${footerParts.join(" · ")}`));

  return lines.join("\n");
}

/**
 * Machine-readable form of `agentrelay heatmap`, mirroring the
 * `renderToolsJson`/`renderStatsJson` envelope: the resolved store path, when it
 * was generated, the optional active scope, and the full distribution. Pure:
 * `generatedAt` is injected, never read from an ambient clock here.
 */
export function renderHeatmapJson(payload: {
  storePath: string;
  generatedAt: string;
  scope?: Record<string, unknown>;
  activity: HourlyActivity;
}): string {
  return JSON.stringify(payload, null, 2);
}
