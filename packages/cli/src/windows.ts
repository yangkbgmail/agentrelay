// Rendering helpers for `agentrelay windows` — the reset-window (lead-time)
// distribution: how far in the future each detected rate-limit reset was set,
// i.e. how long the relay actually had to wait out a limit. Built from the
// per-job detection provenance persisted on `lastRateLimit`. Kept as pure
// functions here, separate from the commander wiring in cli.ts, so the exact
// output is unit-testable without a store or a clock.

import type { LeadTimeSummary } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Shown when the store (or scoped subset) has no jobs at all. */
export const NO_WINDOWS_MESSAGE = "No jobs yet. Run `agentrelay run -- <your agent command>` to get started.";

/** Shown when a `--status`/`--tool`/`--project` scope matches nothing. */
export const NO_SCOPE_MATCH_MESSAGE = "No jobs match the current filter.";

/** Shown when jobs exist but none carry a usable rate-limit detection yet. */
export const NO_DETECTIONS_MESSAGE = "No rate-limit detections recorded on any job yet.";

/** Max width (chars) of a full-scale bar in the per-pattern lead-time table. */
const BAR_WIDTH = 20;

/** A proportional bar `count/max` scaled to {@link BAR_WIDTH}; ≥1 for any nonzero count. */
function bar(count: number, max: number): string {
  if (max <= 0 || count <= 0) return "";
  const filled = Math.max(1, Math.round((count / max) * BAR_WIDTH));
  return "█".repeat(filled);
}

/**
 * Renders the lead-time summary as a multi-line block: a header, the overall
 * distribution (min / median / avg / p90 / max), then a per-pattern breakdown
 * showing which message formats imply short vs long waits. Pure: no I/O, no
 * clock — durations are formatted, never compared to "now". `color` gates ANSI
 * codes (TTY only); a `scopeNote` is echoed once at the top when a filter is
 * active.
 */
export function renderWindows(summary: LeadTimeSummary, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [];
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));

  if (summary.total === 0) {
    lines.push(options.scopeNote ? NO_SCOPE_MATCH_MESSAGE : NO_WINDOWS_MESSAGE);
    return lines.join("\n");
  }
  if (summary.count === 0) {
    lines.push(NO_DETECTIONS_MESSAGE);
    const detail =
      summary.withDetection > 0
        ? `  ${summary.total} job(s) tracked; ${summary.withDetection} detection(s) but none with a usable window (${summary.skipped} skipped)`
        : `  ${summary.total} job(s) tracked, 0 with a recorded rate-limit detection`;
    lines.push(d(detail));
    return lines.join("\n");
  }

  const skippedNote = summary.skipped > 0 ? `; ${summary.skipped} skipped` : "";
  lines.push(
    b(`reset window (lead time) across ${summary.count} detection(s)`) +
      d(` (of ${summary.total} job(s); ${summary.withoutDetection} without a detection${skippedNote})`)
  );
  lines.push("");
  lines.push(
    `  min ${b(formatDurationMs(summary.minMs ?? 0))}` +
      `   median ${b(formatDurationMs(summary.medianMs ?? 0))}` +
      `   avg ${b(formatDurationMs(summary.avgMs ?? 0))}` +
      `   p90 ${b(formatDurationMs(summary.p90Ms ?? 0))}` +
      `   max ${b(formatDurationMs(summary.maxMs ?? 0))}`
  );

  if (summary.byPattern.length > 0) {
    lines.push("");
    lines.push(d("by pattern (avg lead, count):"));
    const maxCount = summary.byPattern.reduce((m, p) => Math.max(m, p.count), 0);
    const nameWidth = Math.min(28, Math.max(...summary.byPattern.map((p) => p.pattern.length)));
    for (const p of summary.byPattern) {
      const name = p.pattern.length > nameWidth ? p.pattern.slice(0, nameWidth) : p.pattern.padEnd(nameWidth);
      const count = String(p.count).padStart(4);
      const avg = formatDurationMs(p.avgMs).padStart(8);
      const range = d(`  [${formatDurationMs(p.minMs)} – ${formatDurationMs(p.maxMs)}]`);
      lines.push(`  ${name} ${count}  ${avg}  ${bar(p.count, maxCount)}${range}`);
    }
  }

  return lines.join("\n");
}

/**
 * Machine-readable form of `agentrelay windows`, mirroring the `renderPatternsJson`
 * envelope: the resolved store path, when it was generated, the optional active
 * scope, and the full summary. Pure: `generatedAt` is injected, never read from
 * an ambient clock here.
 */
export function renderWindowsJson(payload: {
  storePath: string;
  generatedAt: string;
  scope?: Record<string, unknown>;
  summary: LeadTimeSummary;
}): string {
  return JSON.stringify(payload, null, 2);
}
