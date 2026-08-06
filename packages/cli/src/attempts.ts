// Rendering helpers for `agentrelay attempts` — a histogram of how many resume
// attempts each job needed, built from `job.attempts`. Where `stats` reports the
// sum of attempts and the count of retried jobs, this shows the *shape*: how many
// jobs the relay got through on the first pass vs. the retry tail. Kept as pure
// functions here, separate from the commander wiring in cli.ts, so the exact
// output is unit-testable without a store or a clock.

import type { AttemptDistribution } from "@agentrelay/core";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Shown when the store (or scoped subset) has no jobs at all. */
export const NO_ATTEMPTS_MESSAGE = "No jobs yet. Run `agentrelay run -- <your agent command>` to get started.";

/** Shown when a `--status`/`--tool`/`--project`/`--since`/`--until` scope matches nothing. */
export const NO_SCOPE_MATCH_MESSAGE = "No jobs match the current filter.";

/** Widest a histogram bar may draw, in characters. */
const MAX_BAR_WIDTH = 28;

/** Format the mean-attempts figure to at most two decimals, trimming trailing zeros. */
function formatMean(mean: number): string {
  return Number.parseFloat(mean.toFixed(2)).toString();
}

/**
 * Renders the attempt histogram as a bar chart: one row per distinct attempts
 * count, ascending, with a proportional bar and the job count (plus an
 * active/done split when a bucket mixes the two). A footer carries the same
 * headline aggregates `stats` reports. Pure: no I/O; `color` gates ANSI codes
 * (TTY only); a `scopeNote` is echoed once at the top when a filter is active.
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

  const levels = dist.buckets.length;
  lines.push(b(`${levels} attempt level(s)`) + d(` across ${dist.total} job(s)`));
  lines.push("");

  // Bars are scaled to the busiest bucket so the tallest one fills MAX_BAR_WIDTH;
  // any non-empty bucket draws at least one block so it never vanishes.
  const maxCount = Math.max(...dist.buckets.map((bucket) => bucket.count));
  const labelWidth = Math.max(8, ...dist.buckets.map((bucket) => String(bucket.attempts).length));

  for (const bucket of dist.buckets) {
    const label = `${bucket.attempts}×`.padStart(labelWidth);
    const barLen = maxCount > 0 ? Math.max(1, Math.round((bucket.count / maxCount) * MAX_BAR_WIDTH)) : 0;
    const bar = "█".repeat(barLen);
    // Only annotate the split when a bucket genuinely mixes active and terminal
    // jobs; a pure-active or pure-done bucket needs no clarifying tail.
    let split = "";
    if (bucket.active > 0 && bucket.terminal > 0) {
      split = d(` (${bucket.active} active, ${bucket.terminal} done)`);
    } else if (bucket.active > 0) {
      split = d(" (active)");
    }
    lines.push(`  ${d(label)}  ${bar} ${bucket.count}${split}`);
  }

  lines.push("");
  const mean = dist.meanAttempts === null ? "—" : formatMean(dist.meanAttempts);
  lines.push(
    d(
      `total attempts ${dist.totalAttempts} · mean ${mean} · retried ${dist.retriedJobs} (>1×) · max ${dist.maxAttempts}×`
    )
  );

  return lines.join("\n");
}

/**
 * Machine-readable form of `agentrelay attempts`, mirroring the
 * `renderToolsJson` / `renderStatsJson` envelope: the resolved store path, when
 * it was generated, the optional active scope, and the full distribution. Pure:
 * `generatedAt` is injected, never read from an ambient clock here.
 */
export function renderAttemptsJson(payload: {
  storePath: string;
  generatedAt: string;
  scope?: Record<string, unknown>;
  distribution: AttemptDistribution;
}): string {
  return JSON.stringify(payload, null, 2);
}
