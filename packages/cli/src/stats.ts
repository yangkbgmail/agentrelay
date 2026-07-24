// Rendering helpers for `agentrelay stats` — a headline summary of relay
// activity (how many jobs, success rate, retries, per-tool/per-project
// breakdown). Kept as pure functions here, separate from the commander wiring
// in cli.ts, so the exact output is unit-testable without a store or a clock.

import type { DailyActivity, GroupDimension, GroupedStat, JobScope, JobStatus, RelayStats } from "@agentrelay/core";
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

  const { cooldown } = stats;
  if (cooldown.bridgedJobs > 0) {
    lines.push("");
    lines.push(b("cooldown bridged") + d(" (rate-limit wait the relay absorbed for you)"));
    lines.push(
      `  total ${formatDurationMs(cooldown.totalBridgedMs)}` +
        `   avg ${formatDurationMs(cooldown.avgBridgedMs ?? 0)}` +
        `   max ${formatDurationMs(cooldown.maxBridgedMs ?? 0)} ` +
        d(`over ${cooldown.bridgedJobs} job(s)`)
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

/** Shown by `stats --group-by` when the store (or scoped subset) has no jobs. */
export const NO_GROUP_MESSAGE = "No jobs to group.";

/**
 * Renders a per-group stats breakdown as a compact multi-line block: one row
 * per group with its count, success rate, and typical (median) resolution time,
 * ranked by count. Pure: no I/O, no clock. `color` gates ANSI codes (TTY only).
 * A `scopeNote` is echoed once at the top when a filter is active.
 */
export function renderGroupedStats(
  groups: GroupedStat[],
  dimension: GroupDimension,
  options: { color?: boolean; scopeNote?: string } = {}
): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [];
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));
  if (groups.length === 0) {
    lines.push(options.scopeNote ? NO_SCOPE_MATCH_MESSAGE : NO_GROUP_MESSAGE);
    return lines.join("\n");
  }

  const total = groups.reduce((sum, g) => sum + g.count, 0);
  lines.push(b(`${total} job(s) across ${groups.length} ${dimension}(s)`));
  lines.push("");
  // Width the key column to the widest key (capped) so rows line up.
  const keyWidth = Math.min(24, Math.max(dimension.length, ...groups.map((g) => Math.min(24, g.key.length))));
  lines.push(`  ${d(pad(dimension, keyWidth))}  ${d("jobs")}  ${d("success")}  ${d("median resolve")}`);
  for (const { key, count, stats } of groups) {
    const { timing } = stats;
    const median = timing.resolvedCount > 0 ? formatDurationMs(timing.medianResolutionMs ?? 0) : "-";
    lines.push(
      `  ${pad(key.slice(0, keyWidth), keyWidth)}  ${pad(String(count), 4)}  ` +
        `${pad(formatSuccessRate(stats.successRate), 7)}  ${median}`
    );
  }
  return lines.join("\n");
}

/** Right-pad a string to `width` (no truncation beyond what the caller slices). */
function pad(s: string, width: number): string {
  return s.length >= width ? s : s.padEnd(width);
}

/** Max width (chars) of a full-scale bar in the trend histogram. */
const TREND_BAR_WIDTH = 24;

/**
 * Renders a daily activity histogram (jobs created per UTC day) as a compact
 * ASCII bar chart. Bars are scaled to the busiest day so the shape is readable
 * regardless of absolute volume; a zero day shows a dim baseline dot. Pure: no
 * I/O, no clock. Callers pass the already-computed trend so it stays testable.
 */
export function renderTrend(trend: DailyActivity[], options: { color?: boolean } = {}): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [b("activity") + d(" (jobs created per day, UTC)")];
  if (trend.length === 0) {
    lines.push("  none");
    return lines.join("\n");
  }

  const max = trend.reduce((m, day) => Math.max(m, day.count), 0);
  const total = trend.reduce((sum, day) => sum + day.count, 0);
  for (const { date, count } of trend) {
    // Scale each bar to the busiest day; guarantee at least one block for any
    // non-zero day so small counts don't vanish next to a spike.
    const filled = max === 0 || count === 0 ? 0 : Math.max(1, Math.round((count / max) * TREND_BAR_WIDTH));
    // Pad the plain bar to a fixed width so the count column stays aligned; a
    // zero day shows a single baseline dot (dimmed only when color is on).
    const plain = count === 0 ? "·" : "█".repeat(filled);
    const padded = plain.padEnd(TREND_BAR_WIDTH);
    const shown = count === 0 && color ? padded.replace("·", d("·")) : padded;
    lines.push(`  ${date}  ${shown} ${count}`);
  }
  lines.push(d(`  ${total} job(s) over ${trend.length} day(s)`));
  return lines.join("\n");
}

/** Machine-readable snapshot for `--json` (scripts, jq, other tooling). */
export function renderStatsJson(
  stats: RelayStats,
  storePath: string,
  options: { generatedAt?: string; scope?: JobScope; trend?: DailyActivity[] | null } = {}
): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const scope = options.scope && isJobScopeActive(options.scope) ? options.scope : undefined;
  // Only emit `trend` when --trend was requested; omit it entirely otherwise so
  // the default JSON shape is unchanged for existing consumers.
  const trend = options.trend ?? undefined;
  return JSON.stringify({ storePath, generatedAt, scope, trend, stats }, null, 2);
}

/** Machine-readable snapshot of a grouped breakdown for `--group-by --json`. */
export function renderGroupedStatsJson(
  groups: GroupedStat[],
  dimension: GroupDimension,
  storePath: string,
  options: { generatedAt?: string; scope?: JobScope } = {}
): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const scope = options.scope && isJobScopeActive(options.scope) ? options.scope : undefined;
  return JSON.stringify({ storePath, generatedAt, scope, groupBy: dimension, groups }, null, 2);
}
