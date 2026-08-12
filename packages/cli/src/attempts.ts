// Rendering helpers for `agentrelay attempts` — a fleet-level histogram of how
// many resume cycles each job took, bucketed by its `attempts` value. `stats`
// reports the sum and the retried-job count; this shows the distribution's shape
// (how many jobs finished in one resume versus needed many). Kept as pure
// functions here, separate from the commander wiring in cli.ts, so the exact
// output is unit-testable without a store or a clock.

import type { AttemptDistribution } from "@agentrelay/core";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Shown when the store (or scoped subset) has no jobs at all. */
export const NO_ATTEMPTS_MESSAGE = "No jobs yet. Run `agentrelay run -- <your agent command>` to get started.";

/** Shown when a `--status`/`--tool`/`--project` scope matches nothing. */
export const NO_SCOPE_MATCH_MESSAGE = "No jobs match the current filter.";

/** Max width (chars) of a full-scale bar in the histogram. */
const BAR_WIDTH = 24;

/** A proportional bar `count/max` scaled to {@link BAR_WIDTH}; ≥1 for any nonzero count. */
function bar(count: number, max: number): string {
  if (max <= 0 || count <= 0) return "";
  const filled = Math.max(1, Math.round((count / max) * BAR_WIDTH));
  return "█".repeat(filled);
}

/** Human label for an attempt-count bucket, spelling out the two special cases. */
function bucketLabel(attempts: number): string {
  if (attempts === 0) return "0 (not yet resumed)";
  if (attempts === 1) return "1 resume";
  return `${attempts} resumes`;
}

/**
 * Renders the attempt distribution as a multi-line block: a header (totals and
 * mean), then one row per observed attempt count — its label, the job count, and
 * a proportional bar. Pure: no I/O, no clock. `color` gates ANSI codes (TTY
 * only). A `scopeNote` is echoed once at the top when a filter is active.
 */
export function renderAttempts(
  dist: AttemptDistribution,
  options: { color?: boolean; scopeNote?: string } = {}
): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [];
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));

  if (dist.total === 0) {
    lines.push(options.scopeNote ? NO_SCOPE_MATCH_MESSAGE : NO_ATTEMPTS_MESSAGE);
    return lines.join("\n");
  }

  const mean = dist.meanAttempts === null ? "—" : dist.meanAttempts.toFixed(2);
  lines.push(
    b(`${dist.total} job(s)`) +
      d(
        ` · ${dist.totalAttempts} total resume attempt(s) · mean ${mean}/job · ` +
          `${dist.retriedJobs} retried (>1) · ${dist.neverResumed} not yet resumed`
      )
  );
  lines.push("");

  const maxCount = dist.buckets.reduce((m, bkt) => Math.max(m, bkt.count), 0);
  const labelWidth = Math.max(...dist.buckets.map((bkt) => bucketLabel(bkt.attempts).length));
  for (const bkt of dist.buckets) {
    const label = bucketLabel(bkt.attempts).padEnd(labelWidth);
    const count = String(bkt.count).padStart(4);
    lines.push(`  ${label} ${count}  ${bar(bkt.count, maxCount)}`);
  }

  return lines.join("\n");
}

/**
 * Machine-readable form of `agentrelay attempts`, mirroring the `renderStatsJson`
 * envelope: the resolved store path, when it was generated, the optional active
 * scope, and the full distribution. Pure: `generatedAt` is injected, never read
 * from an ambient clock here.
 */
export function renderAttemptsJson(payload: {
  storePath: string;
  generatedAt: string;
  scope?: Record<string, unknown>;
  distribution: AttemptDistribution;
}): string {
  return JSON.stringify(payload, null, 2);
}
