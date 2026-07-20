// Rendering helpers for `agentrelay stats` — a headline summary of relay
// activity (how many jobs, success rate, retries, per-tool/per-project
// breakdown). Kept as pure functions here, separate from the commander wiring
// in cli.ts, so the exact output is unit-testable without a store or a clock.

import type { GroupDimension, JobScope, JobStatus, RelayStats, StatGroup } from "@agentrelay/core";
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

/** Shown by `stats --group-by` when the store (or scoped subset) is empty. */
export const NO_GROUPS_MESSAGE = "No jobs to group.";

/** Column widths for the group breakdown table (excluding the key column). */
const GROUP_COLS: { header: string; width: number }[] = [
  { header: "total", width: 5 },
  { header: "active", width: 6 },
  { header: "done", width: 4 },
  { header: "success", width: 7 },
  { header: "retried", width: 7 },
  { header: "avg", width: 7 },
  { header: "median", width: 7 },
];

/**
 * Renders a `--group-by <dimension>` breakdown as an aligned comparison table —
 * one row per tool/project/status with its own total, success rate, retries,
 * and typical resolution time. Pure: no I/O, no clock. `color` gates ANSI.
 * Returns {@link NO_GROUPS_MESSAGE} when there are no groups (empty subset).
 */
export function renderStatGroups(
  groups: StatGroup[],
  dimension: GroupDimension,
  options: { color?: boolean; scopeNote?: string } = {}
): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  if (groups.length === 0) return options.scopeNote ? NO_SCOPE_MATCH_MESSAGE : NO_GROUPS_MESSAGE;

  // The key column widens to the longest key (capped) so rows stay aligned.
  const keyWidth = Math.min(24, Math.max(dimension.length, ...groups.map((g) => g.key.length)));

  const lines: string[] = [];
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));
  lines.push(b(`by ${dimension}`) + d(` (${groups.length} group(s))`));

  const header = [dimension.padEnd(keyWidth), ...GROUP_COLS.map((c) => c.header.padStart(c.width))].join("  ");
  lines.push(d(header));

  for (const group of groups) {
    const { stats } = group;
    const resolved = stats.byStatus.completed + stats.byStatus.failed;
    const cells = [
      group.key.slice(0, keyWidth).padEnd(keyWidth),
      String(stats.total).padStart(GROUP_COLS[0].width),
      String(stats.active).padStart(GROUP_COLS[1].width),
      String(resolved).padStart(GROUP_COLS[2].width),
      formatSuccessRate(stats.successRate).padStart(GROUP_COLS[3].width),
      String(stats.retriedJobs).padStart(GROUP_COLS[4].width),
      (stats.timing.avgResolutionMs === null ? "-" : formatDurationMs(stats.timing.avgResolutionMs)).padStart(
        GROUP_COLS[5].width
      ),
      (stats.timing.medianResolutionMs === null ? "-" : formatDurationMs(stats.timing.medianResolutionMs)).padStart(
        GROUP_COLS[6].width
      ),
    ];
    lines.push(cells.join("  "));
  }

  return lines.join("\n");
}

/** Machine-readable `--group-by` snapshot for `--json` (scripts, jq). */
export function renderStatGroupsJson(
  groups: StatGroup[],
  dimension: GroupDimension,
  storePath: string,
  options: { generatedAt?: string; scope?: JobScope } = {}
): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const scope = options.scope && isJobScopeActive(options.scope) ? options.scope : undefined;
  return JSON.stringify({ storePath, generatedAt, scope, groupBy: dimension, groups }, null, 2);
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
