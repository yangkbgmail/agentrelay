// Rendering helpers for `agentrelay windows` — a fleet-level report of how long
// rate limits actually forced the relay to pause, built from the per-job
// detection provenance (`lastRateLimit`) as `resetAt − detectedAt`. This is the
// headline "what did the relay save me" metric. Kept as pure functions here,
// separate from the commander wiring in cli.ts, so the exact output is
// unit-testable without a store or a clock.

import type { RateLimitWindowSummary } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Shown when the store (or scoped subset) has no jobs at all. */
export const NO_WINDOWS_MESSAGE = "No jobs yet. Run `agentrelay run -- <your agent command>` to get started.";

/** Shown when a `--status`/`--tool`/`--project` scope matches nothing. */
export const NO_SCOPE_MATCH_MESSAGE = "No jobs match the current filter.";

/** Shown when jobs exist but none carry a usable rate-limit wait window yet. */
export const NO_WINDOW_DATA_MESSAGE = "No rate-limit wait windows recorded on any job yet.";

/** Max width (chars) of a full-scale bar in the per-pattern rollup. */
const BAR_WIDTH = 20;

/** A proportional bar `value/max` scaled to {@link BAR_WIDTH}; ≥1 for any nonzero value. */
function bar(value: number, max: number): string {
  if (max <= 0 || value <= 0) return "";
  const filled = Math.max(1, Math.round((value / max) * BAR_WIDTH));
  return "█".repeat(filled);
}

/** Compact a full job id to its first 8 chars, matching the `status` table. */
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * Renders the wait-window summary as a multi-line block: a headline (total time
 * rate limits cost + how many windows), a distribution line (avg/median/p90/
 * min/max), a per-pattern rollup with proportional bars, and the longest
 * individual windows. Pure: no I/O, no clock. `color` gates ANSI codes (TTY
 * only). A `scopeNote` is echoed once at the top when a filter is active.
 */
export function renderWindows(
  summary: RateLimitWindowSummary,
  options: { color?: boolean; scopeNote?: string } = {}
): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [];
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));

  if (summary.total === 0) {
    lines.push(options.scopeNote ? NO_SCOPE_MATCH_MESSAGE : NO_WINDOWS_MESSAGE);
    return lines.join("\n");
  }
  if (summary.withWindow === 0) {
    lines.push(NO_WINDOW_DATA_MESSAGE);
    lines.push(d(`  ${summary.total} job(s) tracked, 0 with a usable rate-limit wait window`));
    return lines.join("\n");
  }

  lines.push(
    b(`${formatDurationMs(summary.totalWaitMs)} total rate-limit wait across ${summary.withWindow} window(s)`) +
      d(` (of ${summary.total} job(s); ${summary.withoutWindow} without a window)`)
  );
  lines.push(
    d(
      `  avg ${formatDurationMs(summary.avgWaitMs ?? 0)}` +
        ` · median ${formatDurationMs(summary.medianWaitMs ?? 0)}` +
        ` · p90 ${formatDurationMs(summary.p90WaitMs ?? 0)}` +
        ` · min ${formatDurationMs(summary.minWaitMs ?? 0)}` +
        ` · max ${formatDurationMs(summary.maxWaitMs ?? 0)}`
    )
  );

  if (summary.byPattern.length > 0) {
    lines.push("");
    lines.push(b("By pattern (total wait):"));
    const maxTotal = summary.byPattern.reduce((m, p) => Math.max(m, p.totalWaitMs), 0);
    const nameWidth = Math.min(28, Math.max(...summary.byPattern.map((p) => p.pattern.length)));
    for (const p of summary.byPattern) {
      const name = p.pattern.length > nameWidth ? p.pattern.slice(0, nameWidth) : p.pattern.padEnd(nameWidth);
      const total = formatDurationMs(p.totalWaitMs).padStart(8);
      const meta = d(`  ${p.count}×, avg ${formatDurationMs(p.avgWaitMs)}`);
      lines.push(`  ${name} ${total}  ${bar(p.totalWaitMs, maxTotal)}${meta}`);
    }
  }

  if (summary.longest.length > 0) {
    lines.push("");
    lines.push(b("Longest windows:"));
    for (const w of summary.longest) {
      lines.push(
        `  ${shortId(w.jobId)}  ${formatDurationMs(w.waitMs).padStart(8)}` + d(`  ${w.project} · ${w.pattern}`)
      );
    }
  }

  return lines.join("\n");
}

/**
 * Machine-readable form of `agentrelay windows`, mirroring the `renderStatsJson`
 * envelope: the resolved store path, when it was generated, the optional active
 * scope, and the full summary. Pure: `generatedAt` is injected, never read from
 * an ambient clock here.
 */
export function renderWindowsJson(payload: {
  storePath: string;
  generatedAt: string;
  scope?: Record<string, unknown>;
  summary: RateLimitWindowSummary;
}): string {
  return JSON.stringify(payload, null, 2);
}
