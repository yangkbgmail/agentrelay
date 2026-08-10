// Rendering for `agentrelay forecast` — a capacity-aware answer to "when is the
// backlog actually drained?". Where `eta` reports the countdown to the *latest*
// reset (treating every resume as instant and free), `forecast` runs the drain
// simulation from `@agentrelay/core`: each resume takes real time and only
// `--concurrency` of them run at once, so a herd of jobs that come due together
// serialize behind the bound. This surfaces the contention `eta` hides. Kept as
// pure functions (separate from the commander wiring) so the output is testable
// without a TTY, a clock, or a spawned process.

import type { QueueForecast } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/** Shown when no job is waiting for a reset (empty queue or only active/terminal jobs). */
export const CAUGHT_UP_MESSAGE = "Queue is caught up — no jobs waiting for a reset.";

/** Where the per-resume duration estimate came from, for the footnote. */
export type DurationSource = "flag" | "history" | "default";

function sourceNote(source: DurationSource): string {
  switch (source) {
    case "flag":
      return "from --duration";
    case "history":
      return "median of past resolutions";
    case "default":
      return "default estimate";
  }
}

const shortId = (id: string): string => id.slice(0, 8);

/**
 * Human-friendly summary for the drain forecast. Reuses `formatDurationMs` so
 * durations ("1h 3m"/"2d 4h") match `stats`/`eta`/`overdue` exactly. Pure — the
 * forecast already carries an injected `now`, so no ambient clock is read.
 *
 * `limit` (when a positive integer) trims the per-job timeline to the first N
 * rows; the headline still reflects the full queue.
 */
export function renderForecast(
  forecast: QueueForecast,
  options: { color?: boolean; durationSource?: DurationSource; limit?: number } = {}
): string {
  const color = options.color ?? false;
  const source = options.durationSource ?? "default";
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const g = (s: string): string => (color ? `${GREEN}${s}${RESET}` : s);
  const y = (s: string): string => (color ? `${YELLOW}${s}${RESET}` : s);

  if (forecast.caughtUp) return g(CAUGHT_UP_MESSAGE);

  const plural = forecast.waiting === 1 ? "job" : "jobs";
  const when =
    forecast.drainMs !== null && forecast.drainMs > 0
      ? `in ${b(formatDurationMs(forecast.drainMs))}`
      : b("now (already drained)");
  const head = `Backlog drains ${when}`;

  // Contextualize the concurrency + duration assumptions the sim ran under.
  const assume =
    `${forecast.waiting} ${plural} waiting, ` +
    `${forecast.maxConcurrent}× concurrency, ` +
    `~${formatDurationMs(forecast.jobDurationMs)}/resume (${sourceNote(source)})`;

  const lines = [head, d(assume + ".")];

  // Only worth mentioning the contention penalty when it is non-trivial.
  if (forecast.contentionMs !== null && forecast.contentionMs > 0) {
    const naive =
      forecast.naiveEtaMs !== null && forecast.naiveEtaMs > 0 ? formatDurationMs(forecast.naiveEtaMs) : "now";
    lines.push(
      y(
        `+${formatDurationMs(forecast.contentionMs)} of contention vs the plain ETA ` +
          `(last reset ${naive}) — raise --concurrency to shrink it.`
      )
    );
  }

  const shown =
    typeof options.limit === "number" && options.limit > 0
      ? forecast.entries.slice(0, options.limit)
      : forecast.entries;
  for (const e of shown) {
    const startsIn = e.startMs > 0 ? `starts in ${formatDurationMs(e.startMs)}` : "starts now";
    const doneIn = e.finishMs > 0 ? formatDurationMs(e.finishMs) : "now";
    const wait = e.queuedMs > 0 ? y(` (waits ${formatDurationMs(e.queuedMs)} for a slot)`) : "";
    lines.push(`  ${shortId(e.jobId)} ${d(`[${e.project}]`)} ${startsIn}, done in ${doneIn}${wait}`);
  }

  const hidden = forecast.entries.length - shown.length;
  if (hidden > 0) lines.push(d(`  … ${hidden} more.`));

  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq): the full `QueueForecast`
 * plus the store path, generation timestamp, and duration source — matching the
 * envelope of `eta --json` / `next --json`.
 */
export function renderForecastJson(
  forecast: QueueForecast,
  storePath: string,
  options: { durationSource?: DurationSource; generatedAt?: string } = {}
): string {
  return JSON.stringify(
    {
      storePath,
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      durationSource: options.durationSource ?? "default",
      forecast,
    },
    null,
    2
  );
}
