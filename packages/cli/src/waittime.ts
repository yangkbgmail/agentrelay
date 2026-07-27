// Rendering helpers for `agentrelay waited` — a fleet-level readout of how much
// rate-limit wait AgentRelay absorbed on the user's behalf, built from the
// per-job detection provenance persisted on `lastRateLimit`. Kept as pure
// functions here, separate from the commander wiring in cli.ts, so the exact
// output is unit-testable without a store or a clock.

import type { WaitTimeStats } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Shown when the store (or scoped subset) has no jobs at all. */
export const NO_JOBS_MESSAGE = "No jobs yet. Run `agentrelay run -- <your agent command>` to get started.";

/** Shown when a `--status`/`--tool`/`--project` scope matches nothing. */
export const NO_SCOPE_MATCH_MESSAGE = "No jobs match the current filter.";

/** Shown when jobs exist but none carry a usable rate-limit wait yet. */
export const NO_WAITS_MESSAGE = "No rate-limit waits recorded on any job yet.";

/**
 * Renders the wait-time summary as a human-readable block: the headline total
 * absorbed wait, then average/shortest/longest and a drill-down id for the
 * longest. Pure: no I/O, no clock. `color` gates ANSI codes (TTY only). A
 * `scopeNote` is echoed once at the top when a filter is active.
 */
export function renderWaitTime(stats: WaitTimeStats, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [];
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));

  if (stats.total === 0) {
    lines.push(options.scopeNote ? NO_SCOPE_MATCH_MESSAGE : NO_JOBS_MESSAGE);
    return lines.join("\n");
  }
  if (stats.withWait === 0) {
    lines.push(NO_WAITS_MESSAGE);
    lines.push(d(`  ${stats.total} job(s) tracked, 0 with a recorded rate-limit wait`));
    return lines.join("\n");
  }

  lines.push(
    `${b(formatDurationMs(stats.totalWaitMs))} of rate-limit wait absorbed ` + d(`across ${stats.withWait} job(s)`)
  );
  lines.push(d(`  (${stats.total} job(s) tracked; ${stats.withoutWait} with no recorded wait)`));
  lines.push("");
  lines.push(`  ${b("average:")}  ${formatDurationMs(stats.avgWaitMs ?? 0)}`);
  lines.push(`  ${b("shortest:")} ${formatDurationMs(stats.minWaitMs ?? 0)}`);
  const longest = `  ${b("longest:")}  ${formatDurationMs(stats.maxWaitMs ?? 0)}`;
  lines.push(stats.longestJobId ? `${longest} ${d(`(job ${stats.longestJobId.slice(0, 8)})`)}` : longest);

  return lines.join("\n");
}

/**
 * Machine-readable form of `agentrelay waited`, mirroring the `renderStatsJson`
 * envelope: the resolved store path, when it was generated, the optional active
 * scope, and the full stats. Pure: `generatedAt` is injected, never read from an
 * ambient clock here.
 */
export function renderWaitTimeJson(payload: {
  storePath: string;
  generatedAt: string;
  scope?: Record<string, unknown>;
  stats: WaitTimeStats;
}): string {
  return JSON.stringify(payload, null, 2);
}
