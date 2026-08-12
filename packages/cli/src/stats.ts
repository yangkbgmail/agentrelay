// Rendering helpers for `agentrelay stats` — a headline summary of relay
// activity (how many jobs, success rate, retries, per-tool/per-project
// breakdown). Kept as pure functions here, separate from the commander wiring
// in cli.ts, so the exact output is unit-testable without a store or a clock.

import type {
  ActivityHeatmap,
  DailyActivity,
  GroupDimension,
  GroupedStat,
  HourlyActivity,
  JobScope,
  JobStatus,
  RelayStats,
  WeekdayActivity,
} from "@agentrelay/core";
import { isJobScopeActive, WEEKDAY_NAMES } from "@agentrelay/core";
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
 * Renders a coefficient of variation (a unitless stdev/mean ratio) as a
 * human-friendly percentage — `0.4732` → `47%`. Sub-1% ratios keep one decimal
 * so a tiny-but-nonzero spread doesn't collapse to a misleading `0%`.
 */
export function formatCv(cv: number): string {
  if (!Number.isFinite(cv) || cv < 0) return "-";
  const pct = cv * 100;
  if (pct > 0 && pct < 1) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
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
        `   p90 ${formatDurationMs(timing.p90ResolutionMs ?? 0)}` +
        `   p95 ${formatDurationMs(timing.p95ResolutionMs ?? 0)}` +
        `   p99 ${formatDurationMs(timing.p99ResolutionMs ?? 0)}`
    );
    lines.push(
      `  spread: iqr ${formatDurationMs(timing.iqrResolutionMs ?? 0)} ` +
        d(
          `(p25 ${formatDurationMs(timing.p25ResolutionMs ?? 0)} – p75 ${formatDurationMs(timing.p75ResolutionMs ?? 0)})`
        ) +
        `   stdev ${formatDurationMs(timing.stdevResolutionMs ?? 0)}` +
        (timing.cvResolution !== null ? `   cv ${formatCv(timing.cvResolution)}` : "")
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

/**
 * One frame of the live `agentrelay stats --watch` view: a title/header block
 * (matching the shape of `status`/`tools`/`projects --watch`) plus the already
 * composed stats body. Unlike the other watch frames — whose body is a single
 * render call — `stats` can show plain stats, a `--group-by` breakdown, and/or a
 * `--trend` histogram, so the loop composes `body` itself (with a fresh `now`
 * each pass, keeping the "next reset in" countdown live) and this just wraps it
 * in the live banner. Pure: `now` is injected, never read from an ambient clock.
 */
export function renderStatsWatchFrame(
  body: string,
  storePath: string,
  intervalMs: number,
  now: number = Date.now()
): string {
  const stamp = new Date(now).toISOString().replace("T", " ").slice(0, 19);
  const title = `${BOLD}agentrelay stats${RESET} ${DIM}(live, every ${Math.round(
    intervalMs / 1000
  )}s — Ctrl-C to exit)${RESET}`;
  const meta = `${DIM}${stamp}Z · ${storePath}${RESET}`;
  return [title, meta, "", body].join("\n");
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

/** Max width (chars) of a full-scale bar in the hour-of-day histogram. */
const HOURS_BAR_WIDTH = 24;

/**
 * Format a UTC offset (minutes ahead of UTC) as a zone label for the `--hours`
 * / `--weekday` histograms: `0` → `"UTC"`, `540` → `"UTC+09:00"`, `-330` →
 * `"UTC-05:30"`. Pure: the caller (cli.ts) reads the machine offset once and
 * passes it here, so the render/label layer stays clock-free and testable.
 */
export function formatUtcOffsetLabel(offsetMinutes: number): string {
  if (!Number.isFinite(offsetMinutes) || offsetMinutes === 0) return "UTC";
  const sign = offsetMinutes > 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${hh}:${mm}`;
}

/**
 * Renders an hour-of-day activity histogram (jobs created per hour, 0–23,
 * aggregated across all days) as a compact ASCII bar chart. Bars scale to the
 * busiest hour so the shape reads regardless of absolute volume; a zero hour
 * shows a dim baseline dot. `zoneLabel` (default "UTC") names the clock the
 * distribution was bucketed in — pass e.g. `"local (UTC+09:00)"` when the
 * caller shifted timestamps to a local wall clock. Pure: no I/O, no clock.
 * Callers pass the already-computed distribution so it stays testable.
 */
export function renderHours(hours: HourlyActivity[], options: { color?: boolean; zoneLabel?: string } = {}): string {
  const color = options.color ?? false;
  const zone = options.zoneLabel ?? "UTC";
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [b("by hour") + d(` (jobs created per hour of day, ${zone})`)];
  if (hours.length === 0) {
    lines.push("  none");
    return lines.join("\n");
  }

  const max = hours.reduce((m, h) => Math.max(m, h.count), 0);
  const total = hours.reduce((sum, h) => sum + h.count, 0);
  for (const { hour, count } of hours) {
    // Scale each bar to the busiest hour; guarantee at least one block for any
    // non-zero hour so small counts don't vanish next to a spike.
    const filled = max === 0 || count === 0 ? 0 : Math.max(1, Math.round((count / max) * HOURS_BAR_WIDTH));
    // Pad the plain bar to a fixed width so the count column stays aligned; a
    // zero hour shows a single baseline dot (dimmed only when color is on).
    const plain = count === 0 ? "·" : "█".repeat(filled);
    const padded = plain.padEnd(HOURS_BAR_WIDTH);
    const shown = count === 0 && color ? padded.replace("·", d("·")) : padded;
    lines.push(`  ${String(hour).padStart(2, "0")}:00  ${shown} ${count}`);
  }
  lines.push(d(`  ${total} job(s) across 24 hour(s), ${zone}`));
  return lines.join("\n");
}

/** Max width (chars) of a full-scale bar in the day-of-week histogram. */
const WEEKDAY_BAR_WIDTH = 24;

/**
 * Renders a day-of-week activity histogram (jobs created per weekday, Sun–Sat,
 * aggregated across all weeks) as a compact ASCII bar chart. Bars scale to the
 * busiest weekday so the shape reads regardless of absolute volume; a zero day
 * shows a dim baseline dot. `zoneLabel` (default "UTC") names the clock the
 * distribution was bucketed in. Pure: no I/O, no clock. Callers pass the
 * already-computed distribution so it stays testable.
 */
export function renderWeekday(
  weekdays: WeekdayActivity[],
  options: { color?: boolean; zoneLabel?: string } = {}
): string {
  const color = options.color ?? false;
  const zone = options.zoneLabel ?? "UTC";
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [b("by weekday") + d(` (jobs created per day of week, ${zone})`)];
  if (weekdays.length === 0) {
    lines.push("  none");
    return lines.join("\n");
  }

  const max = weekdays.reduce((m, w) => Math.max(m, w.count), 0);
  const total = weekdays.reduce((sum, w) => sum + w.count, 0);
  for (const { name, count } of weekdays) {
    // Scale each bar to the busiest weekday; guarantee at least one block for
    // any non-zero day so small counts don't vanish next to a spike.
    const filled = max === 0 || count === 0 ? 0 : Math.max(1, Math.round((count / max) * WEEKDAY_BAR_WIDTH));
    // Pad the plain bar to a fixed width so the count column stays aligned; a
    // zero day shows a single baseline dot (dimmed only when color is on).
    const plain = count === 0 ? "·" : "█".repeat(filled);
    const padded = plain.padEnd(WEEKDAY_BAR_WIDTH);
    const shown = count === 0 && color ? padded.replace("·", d("·")) : padded;
    lines.push(`  ${name}  ${shown} ${count}`);
  }
  lines.push(d(`  ${total} job(s) across 7 day(s), ${zone}`));
  return lines.join("\n");
}

/** Ramp glyphs for the heatmap, from lightest (few jobs) to heaviest (busiest). */
const HEATMAP_RAMP = ["░", "▒", "▓", "█"] as const;
/** Glyph shown for a cell with zero jobs (a dim baseline dot). */
const HEATMAP_EMPTY = "·";

/**
 * Picks a heatmap glyph for `count` relative to the busiest cell `max`. Zero
 * cells get a baseline dot; non-zero cells map into four ramp levels by their
 * share of the peak, so a single glance shows where activity concentrates.
 */
function heatmapGlyph(count: number, max: number): string {
  if (count <= 0) return HEATMAP_EMPTY;
  if (max <= 0) return HEATMAP_RAMP[0];
  // Non-zero cells always get at least the lightest block; the busiest cell
  // gets the darkest. Four quartile bands in between.
  const level = Math.min(HEATMAP_RAMP.length - 1, Math.ceil((count / max) * HEATMAP_RAMP.length) - 1);
  return HEATMAP_RAMP[Math.max(0, level)];
}

/**
 * Renders a UTC weekday × hour-of-day activity heatmap (a 7×24 grid) as compact
 * ASCII, combining the day-of-week and hour-of-day axes into one view so a
 * glance shows *when in the week* rate-limits cluster ("Monday mornings").
 * Cells ramp `·░▒▓█` from empty to the busiest cell; an hour axis labels
 * columns 0/6/12/18 and each row is suffixed with its weekday total. Pure: no
 * I/O, no clock. Callers pass the already-computed heatmap so it stays testable.
 */
export function renderHeatmap(heatmap: ActivityHeatmap, options: { color?: boolean; zoneLabel?: string } = {}): string {
  const color = options.color ?? false;
  const zone = options.zoneLabel ?? "UTC";
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [b("heatmap") + d(` (jobs created per ${zone} weekday × hour of day)`)];
  const { cells, total, maxCell } = heatmap;
  if (total === 0) {
    lines.push("  none");
    return lines.join("\n");
  }

  // Six-char row prefix ("  Sun ") lines the grid up under the hour axis.
  const indent = "      ";
  const axis = new Array<string>(24).fill(" ");
  for (const h of [0, 6, 12, 18]) {
    const label = String(h);
    for (let i = 0; i < label.length && h + i < 24; i++) axis[h + i] = label[i] ?? " ";
  }
  lines.push(d(`${indent}${axis.join("")}`));

  for (let weekday = 0; weekday < 7; weekday++) {
    const row = cells[weekday] ?? [];
    const rowTotal = row.reduce((sum, c) => sum + c, 0);
    const grid = row
      .map((count) => {
        const g = heatmapGlyph(count, maxCell);
        return g === HEATMAP_EMPTY && color ? d(g) : g;
      })
      .join("");
    lines.push(`  ${WEEKDAY_NAMES[weekday]} ${grid} ${rowTotal}`);
  }

  const legend = `less ${HEATMAP_RAMP.join("")} more`;
  lines.push(d(`  ${legend}    ${total} job(s), ${zone} (peak ${maxCell}/cell)`));
  return lines.join("\n");
}

/** Machine-readable snapshot for `--json` (scripts, jq, other tooling). */
export function renderStatsJson(
  stats: RelayStats,
  storePath: string,
  options: {
    generatedAt?: string;
    scope?: JobScope;
    trend?: DailyActivity[] | null;
    hours?: HourlyActivity[] | null;
    weekday?: WeekdayActivity[] | null;
    heatmap?: ActivityHeatmap | null;
  } = {}
): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const scope = options.scope && isJobScopeActive(options.scope) ? options.scope : undefined;
  // Only emit `trend`/`hours`/`weekday`/`heatmap` when the matching flag was
  // requested; omit them otherwise so the default JSON shape is unchanged for
  // existing consumers.
  const trend = options.trend ?? undefined;
  const hours = options.hours ?? undefined;
  const weekday = options.weekday ?? undefined;
  const heatmap = options.heatmap ?? undefined;
  return JSON.stringify({ storePath, generatedAt, scope, trend, hours, weekday, heatmap, stats }, null, 2);
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
