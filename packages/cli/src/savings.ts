// Rendering helpers for `agentrelay savings` — a fleet-level report of the
// unattended rate-limit wait the relay has bridged on your behalf, built from
// the per-job `lastRateLimit` provenance. Kept as pure functions here, separate
// from the commander wiring in cli.ts, so the exact output is unit-testable
// without a store or a clock.

import type { RelaySavings } from "@agentrelay/core";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Shown when the store (or scoped subset) has no jobs at all. */
export const NO_JOBS_MESSAGE = "No jobs yet. Run `agentrelay run -- <your agent command>` to get started.";

/** Shown when a `--status`/`--tool`/`--project` scope matches nothing. */
export const NO_SCOPE_MATCH_MESSAGE = "No jobs match the current filter.";

/** Shown when jobs exist but none carry a bridged rate-limit window yet. */
export const NO_SAVINGS_MESSAGE = "No bridged rate-limit windows recorded yet — nothing waited out so far.";

/**
 * Human-friendly span for an elapsed duration (not a countdown). Picks the two
 * most-significant units so the number stays scannable across the whole range
 * the relay produces: sub-minute waits up through multi-day backoff. A zero
 * span reads "0s" rather than an empty string.
 */
export function formatSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
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

/** Max width (chars) of a full-scale bar in the per-tool histogram. */
const BAR_WIDTH = 20;

/** A proportional bar `value/max` scaled to {@link BAR_WIDTH}; ≥1 for any nonzero value. */
function bar(value: number, max: number): string {
  if (max <= 0 || value <= 0) return "";
  const filled = Math.max(1, Math.round((value / max) * BAR_WIDTH));
  return "█".repeat(filled);
}

/**
 * Renders the savings report as a multi-line block: a headline total, a couple
 * of stat lines (average / longest window), then a per-tool breakdown with
 * proportional bars. Pure: no I/O, no clock. `color` gates ANSI codes (TTY
 * only). A `scopeNote` is echoed once at the top when a filter is active.
 */
export function renderSavings(savings: RelaySavings, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [];
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));

  if (savings.total === 0) {
    lines.push(options.scopeNote ? NO_SCOPE_MATCH_MESSAGE : NO_JOBS_MESSAGE);
    return lines.join("\n");
  }
  if (savings.bridged === 0) {
    lines.push(NO_SAVINGS_MESSAGE);
    lines.push(d(`  ${savings.total} job(s) tracked, 0 with a bridged rate-limit window`));
    return lines.join("\n");
  }

  lines.push(
    b(`AgentRelay waited ${formatSpan(savings.totalBridgedMs)} for you`) +
      d(` across ${savings.bridged} rate-limit(s) — unattended, auto-resumed`)
  );
  lines.push(d(`  ${savings.total} job(s) tracked; ${savings.total - savings.bridged} without a bridged window`));
  lines.push("");
  lines.push(`  average window  ${formatSpan(savings.averageBridgeMs)}`);
  const longest = savings.longestBridgeJobId ? ` (${savings.longestBridgeJobId.slice(0, 8)})` : "";
  lines.push(`  longest window  ${formatSpan(savings.longestBridgeMs)}${d(longest)}`);

  if (savings.byTool.length > 0) {
    lines.push("");
    lines.push(d("  by tool"));
    const maxMs = savings.byTool.reduce((m, t) => Math.max(m, t.bridgedMs), 0);
    const nameWidth = Math.max(...savings.byTool.map((t) => t.tool.length));
    for (const t of savings.byTool) {
      const name = t.tool.padEnd(nameWidth);
      const span = formatSpan(t.bridgedMs).padStart(8);
      const jobs = d(`  ${t.jobs} job(s)`);
      lines.push(`  ${name}  ${span}  ${bar(t.bridgedMs, maxMs)}${jobs}`);
    }
  }

  return lines.join("\n");
}

/**
 * Machine-readable form of `agentrelay savings`, mirroring the `renderStatsJson`
 * envelope: the resolved store path, when it was generated, the optional active
 * scope, and the full report. Pure: `generatedAt` is injected, never read from
 * an ambient clock here.
 */
export function renderSavingsJson(payload: {
  storePath: string;
  generatedAt: string;
  scope?: Record<string, unknown>;
  savings: RelaySavings;
}): string {
  return JSON.stringify(payload, null, 2);
}
