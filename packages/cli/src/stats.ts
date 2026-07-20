// Rendering helpers for `agentrelay stats` — a headline summary of relay
// activity (how many jobs, success rate, retries, per-tool/per-project
// breakdown). Kept as pure functions here, separate from the commander wiring
// in cli.ts, so the exact output is unit-testable without a store or a clock.

import type { ActivityBucket, JobScope, JobStatus, RelayStats } from "@agentrelay/core";
import { isJobScopeActive } from "@agentrelay/core";
import { formatCountdown } from "./status.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Order statuses appear in the breakdown (lifecycle order). */
const STATUS_ORDER: JobStatus[] = ["queued", "waiting_for_reset", "resuming", "completed", "failed", "cancelled"];

export const NO_STATS_MESSAGE = "No jobs yet. Run `agentrelay run -- <your agent command>` to get started.";

/** Shown by `stats` when a `--status`/`--tool`/`--project` scope matches nothing. */
export const NO_SCOPE_MATCH_MESSAGE = "No jobs match the current filter.";

/** Format a nullable success rate as a percentage string, or "n/a". */
export function formatSuccessRate(rate: number | null): string {
  if (rate === null) return "n/a";
  return `${Math.round(rate * 100)}%`;
}

/**
 * Format an absolute duration (ms) as a compact human string spanning the full
 * range a relay produces: sub-second resolutions up to multi-day windows. Two
 * units of granularity ("4h 12m", "3d 2h", "45m 30s", "8s"). Returns "-" for a
 * negative or non-finite input, "<1s" for a sub-second span.
 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return "<1s";
  const totalSeconds = Math.round(ms / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours % 24;
  const days = Math.floor(totalHours / 24);
  if (days > 0) return `${days}d ${hours}h`;
  if (totalHours > 0) return `${totalHours}h ${minutes}m`;
  if (totalMinutes > 0) return `${totalMinutes}m ${seconds}s`;
  return `${totalSeconds}s`;
}

/** Trend bucket granularities and their width in ms, for `stats --trend`. */
export const TREND_UNITS = ["hour", "day", "week"] as const;
export type TrendUnit = (typeof TREND_UNITS)[number];
export const TREND_UNIT_MS: Record<TrendUnit, number> = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
};

/** Widest bar (in block chars) drawn for the busiest bucket. */
const TREND_BAR_WIDTH = 24;

/**
 * Round `now` up to the next unit boundary so trend buckets land on calendar
 * lines instead of rolling off the wall-clock minute. `hour` snaps to the top
 * of the next hour, `day`/`week` to the next UTC midnight (a week bucket is then
 * a 7-day block ending on a midnight). Keeps the newest bucket's label — a job
 * created today shows under today's date, not yesterday's. Returns `now`
 * unchanged when it's not finite.
 */
export function alignTrendNow(now: number, unit: TrendUnit): number {
  if (!Number.isFinite(now)) return now;
  const step = unit === "hour" ? TREND_UNIT_MS.hour : TREND_UNIT_MS.day;
  return Math.ceil(now / step) * step;
}

/**
 * Label a bucket's start time for the given granularity, in UTC so the output
 * is deterministic regardless of the host timezone. `day`/`week` → `YYYY-MM-DD`,
 * `hour` → `YYYY-MM-DD HH:00`.
 */
export function formatTrendLabel(startMs: number, unit: TrendUnit): string {
  const iso = new Date(startMs).toISOString();
  if (unit === "hour") return `${iso.slice(0, 10)} ${iso.slice(11, 13)}:00`;
  return iso.slice(0, 10);
}

/**
 * Renders an activity histogram (one row per bucket, oldest → newest) as a
 * block-bar chart with per-bucket counts. Pure: no I/O, no clock. Bars are
 * scaled to the busiest bucket; any non-zero bucket shows at least one block so
 * a small-but-present count is never invisible. `color` gates ANSI codes.
 */
export function renderActivityTrend(
  buckets: ActivityBucket[],
  options: { unit: TrendUnit; color?: boolean } = { unit: "day" }
): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  const lines: string[] = [];
  lines.push(
    b(`activity (jobs created per ${options.unit})`) + d(`  ${total} over ${buckets.length} ${options.unit}(s)`)
  );

  if (buckets.length === 0) {
    lines.push("  (no window)");
    return lines.join("\n");
  }

  const max = buckets.reduce((m, bucket) => Math.max(m, bucket.count), 0);
  const labelWidth = Math.max(...buckets.map((bucket) => formatTrendLabel(bucket.startMs, options.unit).length));
  for (const bucket of buckets) {
    const label = formatTrendLabel(bucket.startMs, options.unit).padEnd(labelWidth);
    const barLen =
      max === 0 ? 0 : Math.max(bucket.count > 0 ? 1 : 0, Math.round((bucket.count / max) * TREND_BAR_WIDTH));
    const bar = "█".repeat(barLen);
    lines.push(`  ${d(label)} ${bar}${bar ? " " : ""}${bucket.count}`);
  }

  return lines.join("\n");
}

/**
 * Renders the stats summary as a multi-line block. Pure: no I/O, no ambient
 * clock unless `now` is omitted. `color` gates ANSI codes (TTY only).
 */
export function renderStats(
  stats: RelayStats,
  options: { now?: number; color?: boolean; scopeNote?: string } = {}
): string {
  // With a scope active, an empty subset is "nothing matched", not "no jobs
  // yet" — the store may be full. The command distinguishes the two before
  // calling, but keep the render honest if handed an empty scoped stats.
  if (stats.total === 0) return options.scopeNote ? NO_SCOPE_MATCH_MESSAGE : NO_STATS_MESSAGE;
  const now = options.now ?? Date.now();
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [];
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));
  lines.push(b(`${stats.total} job(s) tracked`));
  lines.push(`  active: ${stats.active}   terminal: ${stats.terminal}`);

  const resolved = stats.byStatus.completed + stats.byStatus.failed;
  lines.push(
    `  success rate: ${formatSuccessRate(stats.successRate)} ` +
      d(`(${stats.byStatus.completed}/${resolved} resolved; cancelled excluded)`)
  );
  lines.push(`  total attempts: ${stats.totalAttempts}   retried jobs: ${stats.retriedJobs}`);
  if (stats.nextResetAt !== null) {
    lines.push(`  next reset in: ${formatCountdown(stats.nextResetAt, now)}`);
  }

  const { timing } = stats;
  if (timing.resolvedCount > 0) {
    lines.push("");
    lines.push(b("resolution time") + d(" (completed + failed)"));
    lines.push(
      `  avg ${formatDurationMs(timing.avgResolutionMs ?? 0)}` +
        `   min ${formatDurationMs(timing.minResolutionMs ?? 0)}` +
        `   max ${formatDurationMs(timing.maxResolutionMs ?? 0)} ` +
        d(`over ${timing.resolvedCount} job(s)`)
    );
    lines.push(
      `  median ${formatDurationMs(timing.medianResolutionMs ?? 0)}` +
        `   p90 ${formatDurationMs(timing.p90ResolutionMs ?? 0)}`
    );
  }

  const statusParts = STATUS_ORDER.filter((s) => stats.byStatus[s] > 0).map((s) => `${s}:${stats.byStatus[s]}`);
  lines.push("");
  lines.push(b("by status"));
  lines.push(`  ${statusParts.length > 0 ? statusParts.join("  ") : "none"}`);

  const toolParts = Object.entries(stats.byTool)
    .filter(([, count]) => count > 0)
    .map(([tool, count]) => `${tool}:${count}`);
  lines.push("");
  lines.push(b("by tool"));
  lines.push(`  ${toolParts.length > 0 ? toolParts.join("  ") : "none"}`);

  lines.push("");
  lines.push(b("top projects"));
  if (stats.projects.length === 0) {
    lines.push("  none");
  } else {
    for (const { project, count } of stats.projects.slice(0, 5)) {
      lines.push(`  ${project.slice(0, 24).padEnd(24)} ${count}`);
    }
  }

  return lines.join("\n");
}

/** Machine-readable snapshot for `--json` (scripts, jq, other tooling). */
export function renderStatsJson(
  stats: RelayStats,
  storePath: string,
  options: { generatedAt?: string; scope?: JobScope; trend?: { unit: TrendUnit; buckets: ActivityBucket[] } } = {}
): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const scope = options.scope && isJobScopeActive(options.scope) ? options.scope : undefined;
  const trend = options.trend ? { unit: options.trend.unit, buckets: options.trend.buckets } : undefined;
  return JSON.stringify({ storePath, generatedAt, scope, stats, trend }, null, 2);
}
