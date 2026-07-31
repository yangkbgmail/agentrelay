// Rendering for `agentrelay waves` — a resume-load histogram that buckets the
// relay's `waiting_for_reset` jobs by when they come due (relative to now), so
// you can see resume *waves* rather than a flat list. Where `next` surfaces the
// single most imminent resume and `upcoming` lists every waiting job, `waves`
// answers "do many jobs land in the same window (a thundering herd that may
// re-hit the rate limit), or is the runway spread out?". Kept as pure functions
// (separate from the commander wiring) so the output is testable without a TTY
// or a clock.

import type { ResumeWaves } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Shown when no job is waiting for a reset (empty queue or only active/terminal jobs). */
export const NO_WAVES_MESSAGE = "No jobs waiting for a reset.";

/** Max width (chars) of a full-scale bar in the histogram. */
const WAVE_BAR_WIDTH = 24;

/**
 * Label for a window as an offset range from now: "now→1h 0m", "1h 0m→2h 0m".
 * Window 0 opens at "now"; every other window uses its `offsetMs`. Reuses
 * `formatDurationMs` so the units match the rest of the CLI.
 */
function windowLabel(offsetMs: number, windowMs: number): string {
  const start = offsetMs === 0 ? "now" : formatDurationMs(offsetMs);
  const end = formatDurationMs(offsetMs + windowMs);
  return `${start}→${end}`;
}

/**
 * Human-friendly histogram: one row per contiguous time window, an ASCII bar
 * scaled to the busiest window, and the job count. The peak window is bolded so
 * a resume wave jumps out. A footer summarizes totals, how many are already due
 * now, the peak, and any jobs pushed past the horizon by `--max-windows`. Pure:
 * no ambient clock, `color` gates ANSI (TTY only).
 */
export function renderWaves(waves: ResumeWaves, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  if (waves.windows.length === 0) {
    const note = options.scopeNote ? ` ${d(`[scope: ${options.scopeNote}]`)}` : "";
    // Nothing bucketed, but a --max-windows horizon could still be hiding due jobs.
    if (waves.beyondHorizon > 0) {
      return `${NO_WAVES_MESSAGE} ${d(`(${waves.beyondHorizon} beyond the shown horizon)`)}${note}`;
    }
    return NO_WAVES_MESSAGE + note;
  }

  const labels = waves.windows.map((w) => windowLabel(w.offsetMs, waves.windowMs));
  const labelWidth = Math.max(...labels.map((l) => l.length));
  const lines: string[] = [];

  if (options.scopeNote) lines.push(d(`[scope: ${options.scopeNote}]`));
  lines.push(b("resume load") + d(` (jobs resuming per ${formatDurationMs(waves.windowMs)} window)`));

  const max = waves.peakCount;
  waves.windows.forEach((w, i) => {
    const label = labels[i].padEnd(labelWidth);
    // Scale each bar to the busiest window; guarantee at least one block for any
    // non-zero window so a single job doesn't vanish next to a spike. A zero
    // window shows a dim baseline dot.
    const filled = max === 0 || w.count === 0 ? 0 : Math.max(1, Math.round((w.count / max) * WAVE_BAR_WIDTH));
    const barPlain = w.count === 0 ? "·" : "█".repeat(filled);
    const bar = w.count === 0 ? d(barPlain.padEnd(WAVE_BAR_WIDTH)) : barPlain.padEnd(WAVE_BAR_WIDTH);
    const isPeak = waves.peakIndex === w.index && w.count > 0;
    const count = isPeak ? b(String(w.count)) : String(w.count);
    lines.push(`  ${label}  ${bar} ${count}`);
  });

  lines.push("");
  lines.push(d(footer(waves)));
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the store path, a
 * generation timestamp, the optional active scope, and the full histogram —
 * windows plus the honest totals (`totalWaiting`/`dueNow`/`beyondHorizon`).
 */
export function renderWavesJson(input: {
  storePath: string;
  generatedAt?: string;
  scope?: Record<string, unknown>;
  waves: ResumeWaves;
}): string {
  return JSON.stringify(
    {
      storePath: input.storePath,
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      scope: input.scope,
      waves: input.waves,
    },
    null,
    2
  );
}

function footer(waves: ResumeWaves): string {
  const jobWord = waves.totalWaiting === 1 ? "job" : "jobs";
  const parts = [`${waves.totalWaiting} ${jobWord} waiting`];
  if (waves.dueNow > 0) parts.push(`${waves.dueNow} due now`);
  if (waves.peakCount > 0 && waves.peakIndex !== null) {
    const peak = waves.windows[waves.peakIndex];
    parts.push(`peak ${waves.peakCount} in ${windowLabel(peak.offsetMs, waves.windowMs)}`);
  }
  if (waves.beyondHorizon > 0) parts.push(`${waves.beyondHorizon} beyond horizon`);
  return parts.join(" · ");
}
