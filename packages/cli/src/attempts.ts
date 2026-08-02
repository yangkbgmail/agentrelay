// Rendering helpers for `agentrelay attempts` — a histogram of how many resume
// attempts jobs have burned, built from the `job.attempts` counter the
// scheduler bumps on every resume. Where `agentrelay errors` groups jobs by
// *why* they failed, this groups them by *how hard the relay worked* on them,
// and — when the configured retry ceiling is known — flags the jobs pressed
// against it. Kept as pure functions here, separate from the commander wiring in
// cli.ts, so the exact output is unit-testable without a store or a clock.

import type { AttemptsSummary } from "@agentrelay/core";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/** Shown when the store (or scoped subset) has no jobs at all. */
export const NO_ATTEMPTS_MESSAGE = "No jobs yet. Run `agentrelay run -- <your agent command>` to get started.";

/** Shown when a `--status`/`--tool`/`--project` scope matches nothing. */
export const NO_SCOPE_MATCH_MESSAGE = "No jobs match the current filter.";

/** Max width (chars) of a full-scale bar in the attempt histogram. */
const BAR_WIDTH = 24;

/** A proportional bar `count/max` scaled to {@link BAR_WIDTH}; ≥1 for any nonzero count. */
function bar(count: number, max: number): string {
  if (max <= 0 || count <= 0) return "";
  const filled = Math.max(1, Math.round((count / max) * BAR_WIDTH));
  return "█".repeat(filled);
}

/**
 * Renders the attempt distribution as a multi-line block: a header with the
 * headline totals, then one histogram row per distinct attempt count (0, 1, 2,
 * …) with a proportional bar, then — when a finite retry ceiling was supplied —
 * a warning line for the jobs at or past it. Pure: no I/O, no clock. `color`
 * gates ANSI codes (TTY only). A `scopeNote` is echoed once at the top when a
 * filter is active.
 */
export function renderAttempts(
  summary: AttemptsSummary,
  options: { color?: boolean; scopeNote?: string } = {}
): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);
  const warn = (s: string) => (color ? `${YELLOW}${s}${RESET}` : s);

  const lines: string[] = [];
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));

  if (summary.total === 0) {
    lines.push(options.scopeNote ? NO_SCOPE_MATCH_MESSAGE : NO_ATTEMPTS_MESSAGE);
    return lines.join("\n");
  }

  const avg = summary.total > 0 ? summary.totalAttempts / summary.total : 0;
  lines.push(
    b(`${summary.total} job(s)`) +
      d(
        ` · ${summary.totalAttempts} total attempt(s) · avg ${avg.toFixed(1)} · ` +
          `${summary.retried} retried · ${summary.neverAttempted} not yet resumed`
      )
  );
  lines.push("");

  const maxCount = summary.buckets.reduce((m, bkt) => Math.max(m, bkt.count), 0);
  // Right-align the attempt label to the widest value present for a clean column.
  const labelWidth = Math.max(...summary.buckets.map((bkt) => String(bkt.attempts).length));
  lines.push(d(`  ${"ATTEMPTS".padStart(labelWidth + 1)}  ${"JOBS".padStart(5)}`));
  for (const bkt of summary.buckets) {
    const atCeiling = summary.ceiling !== null && bkt.attempts >= summary.ceiling;
    const label = String(bkt.attempts).padStart(labelWidth + 1);
    const count = String(bkt.count).padStart(5);
    const drawn = bar(bkt.count, maxCount);
    const barCell = atCeiling ? warn(drawn) : drawn;
    const flag = atCeiling ? warn("  ⚠ at ceiling") : "";
    lines.push(`  ${label}  ${count}  ${barCell}${flag}`);
  }

  if (summary.ceiling !== null) {
    lines.push("");
    if (summary.atCeiling > 0) {
      lines.push(warn(`⚠ ${summary.atCeiling} job(s) at or past the retry ceiling (maxAttempts=${summary.ceiling}).`));
      lines.push(d("  These won't be retried further; inspect with `agentrelay errors` / `agentrelay show <id>`."));
    } else {
      lines.push(d(`Retry ceiling maxAttempts=${summary.ceiling}; no job has reached it.`));
    }
  }

  return lines.join("\n");
}

/**
 * Machine-readable form of `agentrelay attempts`, mirroring the `renderStatsJson`
 * / `renderToolsJson` envelope: the resolved store path, when it was generated,
 * the optional active scope, and the full summary. Pure: `generatedAt` is
 * injected, never read from an ambient clock here.
 */
export function renderAttemptsJson(payload: {
  storePath: string;
  generatedAt: string;
  scope?: Record<string, unknown>;
  summary: AttemptsSummary;
}): string {
  return JSON.stringify(payload, null, 2);
}
