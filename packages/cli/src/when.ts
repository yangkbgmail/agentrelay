// Rendering helpers for `agentrelay when` — an hour-of-day histogram of when
// rate limits actually hit, built from the per-job detection provenance
// (`lastRateLimit.detectedAt`). Kept as pure functions here, separate from the
// commander wiring in cli.ts, so the exact output is unit-testable without a
// store or a clock.

import type { HourlyRateLimitDistribution } from "@agentrelay/core";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Shown when the store (or scoped subset) has no jobs at all. */
export const NO_WHEN_MESSAGE = "No jobs yet. Run `agentrelay run -- <your agent command>` to get started.";

/** Shown when a `--status`/`--tool`/`--project` scope matches nothing. */
export const NO_SCOPE_MATCH_MESSAGE = "No jobs match the current filter.";

/** Shown when jobs exist but none carry a usable rate-limit detection timestamp. */
export const NO_DETECTIONS_MESSAGE = "No rate-limit detections recorded on any job yet.";

/** Max width (chars) of a full-scale bar in the hour histogram. */
const BAR_WIDTH = 24;

/** A proportional bar `count/max` scaled to {@link BAR_WIDTH}; ≥1 for any nonzero count. */
function bar(count: number, max: number): string {
  if (max <= 0 || count <= 0) return "";
  const filled = Math.max(1, Math.round((count / max) * BAR_WIDTH));
  return "█".repeat(filled);
}

/**
 * Render a UTC-offset (minutes east of UTC) as a `UTC±HH:MM` label, matching how
 * ISO-8601 spells zone offsets. `0` is `UTC`; fractional-hour zones (e.g. India's
 * +05:30) keep their minutes.
 */
export function formatOffsetLabel(utcOffsetMinutes: number): string {
  if (!Number.isFinite(utcOffsetMinutes) || utcOffsetMinutes === 0) return "UTC";
  const sign = utcOffsetMinutes > 0 ? "+" : "-";
  const abs = Math.abs(utcOffsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${hh}:${mm}`;
}

/** A left-padded two-digit hour label, e.g. `09` or `14`. */
function hourLabel(hour: number): string {
  return String(hour).padStart(2, "0");
}

/**
 * Renders the distribution as a 24-row hour-of-day histogram: one row per hour
 * (`HH  count  bar`), with the busiest hour flagged. Pure: no I/O, no clock.
 * `color` gates ANSI codes (TTY only). A `scopeNote` is echoed once at the top
 * when a filter is active. Rows for empty hours are kept so the daily shape
 * (quiet stretches and peaks) is readable at a glance.
 */
export function renderWhen(
  distribution: HourlyRateLimitDistribution,
  options: { color?: boolean; scopeNote?: string } = {}
): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const offsetLabel = formatOffsetLabel(distribution.utcOffsetMinutes);
  const lines: string[] = [];
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));

  if (distribution.total === 0) {
    lines.push(options.scopeNote ? NO_SCOPE_MATCH_MESSAGE : NO_WHEN_MESSAGE);
    return lines.join("\n");
  }
  if (distribution.withDetection === 0) {
    lines.push(NO_DETECTIONS_MESSAGE);
    lines.push(d(`  ${distribution.total} job(s) tracked, 0 with a recorded rate-limit detection`));
    return lines.join("\n");
  }

  const peak =
    distribution.peakHour === null
      ? ""
      : d(` — busiest at ${hourLabel(distribution.peakHour)}:00 (${distribution.peakCount})`);
  lines.push(
    b(`${distribution.withDetection} detection(s) by hour of day`) +
      d(` [${offsetLabel}]`) +
      d(` (of ${distribution.total} job(s); ${distribution.withoutDetection} without a detection)`) +
      peak
  );
  lines.push("");

  const maxCount = distribution.buckets.reduce((m, x) => Math.max(m, x.count), 0);
  for (const bucket of distribution.buckets) {
    const isPeak = bucket.hour === distribution.peakHour;
    const label = hourLabel(bucket.hour);
    const count = String(bucket.count).padStart(4);
    // Zero hours read dim so the eye tracks the active stretches.
    const barText = bucket.count === 0 ? d("·") : bar(bucket.count, maxCount);
    const marker = isPeak ? d(" ◄ peak") : "";
    const row = `  ${label}:00 ${count}  ${barText}${marker}`;
    lines.push(bucket.count === 0 ? d(`  ${label}:00 ${count}  ${barText}`) : row);
  }

  return lines.join("\n");
}

/**
 * Machine-readable form of `agentrelay when`, mirroring the `renderPatternsJson`
 * envelope: the resolved store path, when it was generated, the optional active
 * scope, and the full distribution. Pure: `generatedAt` is injected, never read
 * from an ambient clock here.
 */
export function renderWhenJson(payload: {
  storePath: string;
  generatedAt: string;
  scope?: Record<string, unknown>;
  distribution: HourlyRateLimitDistribution;
}): string {
  return JSON.stringify(payload, null, 2);
}
