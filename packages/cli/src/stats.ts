// Rendering helpers for `agentrelay stats` — a headline summary of relay
// activity (how many jobs, success rate, retries, per-tool/per-project
// breakdown). Kept as pure functions here, separate from the commander wiring
// in cli.ts, so the exact output is unit-testable without a store or a clock.

import type { ActivityTrend, JobScope, JobStatus, RelayStats } from "@agentrelay/core";
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

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Width (chars) of the activity bar at the busiest bucket. */
const TREND_BAR_WIDTH = 16;

/**
 * Short recency label for a trend bucket: "now" for the newest window, else
 * "{n}d ago"/"{n}h ago" counted from the newest edge. `index` is the bucket's
 * position (0 = oldest) within a run of `total` buckets of width `bucketMs`.
 */
export function formatTrendLabel(index: number, total: number, bucketMs: number): string {
  const fromNewest = total - 1 - index;
  if (fromNewest === 0) return "now";
  const unit = bucketMs % DAY_MS === 0 ? "d" : bucketMs % HOUR_MS === 0 ? "h" : "";
  if (unit === "d") return `${fromNewest}d ago`;
  if (unit === "h") return `${fromNewest}h ago`;
  // Fall back to a coarse duration for odd widths.
  return `${formatDurationMs(fromNewest * bucketMs)} ago`;
}

/**
 * Renders an activity trend as one bar row per bucket (oldest → newest). The
 * bar length scales to the busiest bucket's total activity (created +
 * resolved). Pure; `color` gates the dim styling. Returns "" for no buckets.
 */
export function renderTrend(trend: ActivityTrend, options: { color?: boolean } = {}): string {
  const { buckets, bucketMs } = trend;
  if (buckets.length === 0) return "";
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const maxTotal = buckets.reduce((m, bk) => Math.max(m, bk.created + bk.resolved), 0);
  const unitWord = bucketMs % DAY_MS === 0 ? "day" : bucketMs % HOUR_MS === 0 ? "hour" : "window";

  const lines: string[] = [];
  lines.push(b("activity") + d(` (per ${unitWord}, last ${buckets.length})`));
  buckets.forEach((bucket, index) => {
    const label = formatTrendLabel(index, buckets.length, bucketMs).padStart(7);
    const total = bucket.created + bucket.resolved;
    const barLen = maxTotal === 0 ? 0 : Math.round((total / maxTotal) * TREND_BAR_WIDTH);
    const bar = "█".repeat(barLen).padEnd(TREND_BAR_WIDTH);
    lines.push(`  ${label}  ${bar}  ${bucket.created} created  ${bucket.resolved} resolved`);
  });
  return lines.join("\n");
}

/**
 * Renders the stats summary as a multi-line block. Pure: no I/O, no ambient
 * clock unless `now` is omitted. `color` gates ANSI codes (TTY only). A
 * pre-computed `trend` is appended as an activity block when supplied.
 */
export function renderStats(
  stats: RelayStats,
  options: { now?: number; color?: boolean; scopeNote?: string; trend?: ActivityTrend } = {}
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

  if (options.trend) {
    const block = renderTrend(options.trend, { color });
    if (block) {
      lines.push("");
      lines.push(block);
    }
  }

  return lines.join("\n");
}

/** Machine-readable snapshot for `--json` (scripts, jq, other tooling). */
export function renderStatsJson(
  stats: RelayStats,
  storePath: string,
  options: { generatedAt?: string; scope?: JobScope; trend?: ActivityTrend } = {}
): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const scope = options.scope && isJobScopeActive(options.scope) ? options.scope : undefined;
  return JSON.stringify({ storePath, generatedAt, scope, stats, trend: options.trend }, null, 2);
}
