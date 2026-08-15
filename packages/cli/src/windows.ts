// Rendering helpers for `agentrelay windows` — a distribution of the rate-limit
// *window* durations the relay has observed (how far in the future each reset
// was from the moment it was detected), built from the per-job detection
// provenance persisted on `lastRateLimit`. Kept as pure functions here, separate
// from the commander wiring in cli.ts, so the exact output is unit-testable
// without a store or a clock.

import type { RateLimitWindowStats } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Shown when the store (or scoped subset) has no jobs at all. */
export const NO_WINDOWS_MESSAGE = "No jobs yet. Run `agentrelay run -- <your agent command>` to get started.";

/** Shown when a `--status`/`--tool`/`--project` scope matches nothing. */
export const NO_SCOPE_MATCH_MESSAGE = "No jobs match the current filter.";

/** Shown when jobs exist but none carry a usable rate-limit detection window yet. */
export const NO_WINDOWS_DETECTED_MESSAGE = "No rate-limit windows recorded on any job yet.";

/**
 * Renders the window distribution as a multi-line block: a header line with how
 * many windows contributed, then min/median/p90/p95/max/avg duration lines. Pure:
 * no I/O, no clock. `color` gates ANSI codes (TTY only). A `scopeNote` is echoed
 * once at the top when a filter is active.
 */
export function renderWindows(
  stats: RateLimitWindowStats,
  options: { color?: boolean; scopeNote?: string } = {}
): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [];
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));

  if (stats.total === 0) {
    lines.push(options.scopeNote ? NO_SCOPE_MATCH_MESSAGE : NO_WINDOWS_MESSAGE);
    return lines.join("\n");
  }
  if (stats.withWindow === 0) {
    lines.push(NO_WINDOWS_DETECTED_MESSAGE);
    lines.push(d(`  ${stats.total} job(s) tracked, 0 with a recorded rate-limit window`));
    return lines.join("\n");
  }

  lines.push(
    b("rate-limit window") +
      d(` (reset − detected, over ${stats.withWindow} detection(s); ${stats.withoutWindow} without)`)
  );
  lines.push(
    `  min ${formatDurationMs(stats.minMs ?? 0)}` +
      `   median ${formatDurationMs(stats.medianMs ?? 0)}` +
      `   p90 ${formatDurationMs(stats.p90Ms ?? 0)}` +
      `   p95 ${formatDurationMs(stats.p95Ms ?? 0)}`
  );
  lines.push(`  max ${formatDurationMs(stats.maxMs ?? 0)}` + `   avg ${formatDurationMs(stats.avgMs ?? 0)}`);

  return lines.join("\n");
}

/**
 * Machine-readable form of `agentrelay windows`, mirroring the `renderPatternsJson`
 * envelope: the resolved store path, when it was generated, the optional active
 * scope, and the full window distribution. Pure: `generatedAt` is injected, never
 * read from an ambient clock here.
 */
export function renderWindowsJson(payload: {
  storePath: string;
  generatedAt: string;
  scope?: Record<string, unknown>;
  windows: RateLimitWindowStats;
}): string {
  return JSON.stringify(payload, null, 2);
}
