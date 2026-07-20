// Rendering helpers for `agentrelay stats` — a headline summary of relay
// activity (how many jobs, success rate, retries, per-tool/per-project
// breakdown). Kept as pure functions here, separate from the commander wiring
// in cli.ts, so the exact output is unit-testable without a store or a clock.

import type { JobScope, JobStatus, RelayStats, StatGroup, StatGroupDimension } from "@agentrelay/core";
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

/** Longest group key we print before truncating, keeping the table aligned. */
const MAX_GROUP_KEY_WIDTH = 24;

/**
 * Renders a comparative table — one row per group — for
 * `agentrelay stats --group-by <tool|project|status>`. Where {@link renderStats}
 * shows one store-wide block, this puts the headline metrics (jobs, active,
 * done, success rate, median resolution) side-by-side so groups can be compared
 * at a glance. Pure: no I/O, no ambient clock unless omitted.
 */
export function renderGroupedStats(
  groups: StatGroup[],
  dimension: StatGroupDimension,
  options: { color?: boolean; scopeNote?: string } = {}
): string {
  // Empty means either an empty store or a scope that matched nothing — the
  // command distinguishes them, but keep the render honest via scopeNote.
  if (groups.length === 0) return options.scopeNote ? NO_SCOPE_MATCH_MESSAGE : NO_STATS_MESSAGE;
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [];
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));
  lines.push(b(`grouped by ${dimension}`) + d(` (${groups.length} group(s))`));
  lines.push("");

  const keyWidth = Math.min(MAX_GROUP_KEY_WIDTH, Math.max(dimension.length, ...groups.map((g) => g.key.length)));
  const cell = (s: string, width: number) => s.padEnd(width);
  const header = `  ${cell(dimension, keyWidth)}  ${cell("jobs", 5)} ${cell("active", 6)} ${cell("done", 5)} ${cell("success", 7)} median`;
  lines.push(d(header));

  for (const { key, stats } of groups) {
    const label = key.length > keyWidth ? `${key.slice(0, keyWidth - 1)}…` : key;
    const median = stats.timing.medianResolutionMs !== null ? formatDurationMs(stats.timing.medianResolutionMs) : "-";
    lines.push(
      `  ${cell(label, keyWidth)}  ${cell(String(stats.total), 5)} ${cell(String(stats.active), 6)} ` +
        `${cell(String(stats.terminal), 5)} ${cell(formatSuccessRate(stats.successRate), 7)} ${median}`
    );
  }

  return lines.join("\n");
}

/** Machine-readable snapshot of grouped stats for `--json`. */
export function renderGroupedStatsJson(
  groups: StatGroup[],
  dimension: StatGroupDimension,
  storePath: string,
  options: { generatedAt?: string; scope?: JobScope } = {}
): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const scope = options.scope && isJobScopeActive(options.scope) ? options.scope : undefined;
  return JSON.stringify({ storePath, generatedAt, groupBy: dimension, scope, groups }, null, 2);
}

/** Machine-readable snapshot for `--json` (scripts, jq, other tooling). */
export function renderStatsJson(
  stats: RelayStats,
  storePath: string,
  options: { generatedAt?: string; scope?: JobScope } = {}
): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const scope = options.scope && isJobScopeActive(options.scope) ? options.scope : undefined;
  return JSON.stringify({ storePath, generatedAt, scope, stats }, null, 2);
}
