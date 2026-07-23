// Rendering helpers for `agentrelay patterns` — a fleet-level frequency table
// of which rate-limit parser patterns actually fired across the queue, built
// from the per-job detection provenance persisted on `lastRateLimit`. Kept as
// pure functions here, separate from the commander wiring in cli.ts, so the
// exact output is unit-testable without a store or a clock.

import type { RateLimitPatternSummary } from "@agentrelay/core";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Shown when the store (or scoped subset) has no jobs at all. */
export const NO_PATTERNS_MESSAGE = "No jobs yet. Run `agentrelay run -- <your agent command>` to get started.";

/** Shown when a `--status`/`--tool`/`--project` scope matches nothing. */
export const NO_SCOPE_MATCH_MESSAGE = "No jobs match the current filter.";

/** Shown when jobs exist but none carry a rate-limit detection yet. */
export const NO_DETECTIONS_MESSAGE = "No rate-limit detections recorded on any job yet.";

/** Max width (chars) of a full-scale bar in the pattern histogram. */
const BAR_WIDTH = 20;

/** A proportional bar `count/max` scaled to {@link BAR_WIDTH}; ≥1 for any nonzero count. */
function bar(count: number, max: number): string {
  if (max <= 0 || count <= 0) return "";
  const filled = Math.max(1, Math.round((count / max) * BAR_WIDTH));
  return "█".repeat(filled);
}

/** Collapse whitespace/newlines in a raw match sample and cap its length for one-line display. */
function sample(raw: string, max = 40): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Renders the pattern summary as a multi-line block: a header, then one row per
 * pattern (count, proportional bar, and an example matched string), ranked by
 * count. Pure: no I/O, no clock. `color` gates ANSI codes (TTY only). A
 * `scopeNote` is echoed once at the top when a filter is active.
 */
export function renderPatterns(
  summary: RateLimitPatternSummary,
  options: { color?: boolean; scopeNote?: string } = {}
): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [];
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));

  if (summary.total === 0) {
    lines.push(options.scopeNote ? NO_SCOPE_MATCH_MESSAGE : NO_PATTERNS_MESSAGE);
    return lines.join("\n");
  }
  if (summary.withDetection === 0) {
    lines.push(NO_DETECTIONS_MESSAGE);
    lines.push(d(`  ${summary.total} job(s) tracked, 0 with a recorded rate-limit detection`));
    return lines.join("\n");
  }

  lines.push(
    b(`${summary.withDetection} detection(s) across ${summary.patterns.length} pattern(s)`) +
      d(` (of ${summary.total} job(s); ${summary.withoutDetection} without a detection)`)
  );
  lines.push("");

  const maxCount = summary.patterns.reduce((m, p) => Math.max(m, p.count), 0);
  const nameWidth = Math.min(28, Math.max(...summary.patterns.map((p) => p.pattern.length)));
  for (const p of summary.patterns) {
    const name = p.pattern.length > nameWidth ? p.pattern.slice(0, nameWidth) : p.pattern.padEnd(nameWidth);
    const count = String(p.count).padStart(4);
    const example = p.sampleRawMatch ? d(`  e.g. "${sample(p.sampleRawMatch)}"`) : "";
    lines.push(`  ${name} ${count}  ${bar(p.count, maxCount)}${example}`);
  }

  return lines.join("\n");
}

/**
 * Machine-readable form of `agentrelay patterns`, mirroring the `renderStatsJson`
 * envelope: the resolved store path, when it was generated, the optional active
 * scope, and the full summary. Pure: `generatedAt` is injected, never read from
 * an ambient clock here.
 */
export function renderPatternsJson(payload: {
  storePath: string;
  generatedAt: string;
  scope?: Record<string, unknown>;
  summary: RateLimitPatternSummary;
}): string {
  return JSON.stringify(payload, null, 2);
}
