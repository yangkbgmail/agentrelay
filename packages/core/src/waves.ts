import type { RelayJob } from "./types.js";

/**
 * One fixed-width time window in the resume-load histogram. Windows are
 * contiguous and anchored at `now`: window 0 covers `[now, now+windowMs)`,
 * window 1 `[now+windowMs, now+2·windowMs)`, and so on. `count` is how many
 * `waiting_for_reset` jobs come due inside this window.
 */
export interface WaveBucket {
  /** 0-based window index counted forward from `now`. */
  index: number;
  /** Window start (epoch ms), inclusive. */
  startMs: number;
  /** Window end (epoch ms), exclusive. */
  endMs: number;
  /** `startMs - now` — how far ahead this window opens (0 for window 0). */
  offsetMs: number;
  /** How many waiting jobs resume inside this window. */
  count: number;
}

/**
 * A histogram of when the relay's `waiting_for_reset` jobs come due, bucketed
 * into fixed relative time windows counted from `now`. Where `next` answers
 * "what's the single next resume?" and `upcoming` lists every waiting job
 * individually, `waves` aggregates them into resume *waves*: it surfaces
 * whether many jobs land in the same window (a thundering herd that could
 * immediately re-hit the rate limit) versus a smoothly spread-out runway.
 *
 * This is deliberately a *relative countdown* view ("the next hour, the hour
 * after") — complementary to any absolute-clock timeline. Computed purely from
 * the job list and an injected `now` (epoch ms) — no clock, no queue, no I/O —
 * so `agentrelay waves` is unit-testable end to end.
 */
export interface ResumeWaves {
  /**
   * Contiguous windows from `now` up to (and including) the window holding the
   * furthest resume, capped at `maxWindows`. Empty windows between resumes are
   * kept so the histogram shows the true shape (gaps and spikes alike). Empty
   * when nothing is waiting.
   */
  windows: WaveBucket[];
  /** Width of each window in ms (the resolution of the histogram). */
  windowMs: number;
  /** Total `waiting_for_reset` jobs with a parseable reset (before capping). */
  totalWaiting: number;
  /** Waiting jobs already past their reset — folded into window 0, also counted here. */
  dueNow: number;
  /** The busiest single window's `count` (0 when nothing is waiting). */
  peakCount: number;
  /** Index of the first busiest window, or null when nothing is waiting. */
  peakIndex: number | null;
  /**
   * Waiting jobs whose reset falls past the last emitted window because
   * `maxWindows` capped the horizon. Not folded into any window — reported
   * separately so the totals stay honest.
   */
  beyondHorizon: number;
  /** `endMs` of the last window minus `now` (0 when there are no windows). */
  horizonMs: number;
}

/** Default window width: one hour — the natural resolution for rate-limit resets. */
export const DEFAULT_WAVE_WINDOW_MS = 60 * 60 * 1000;
/** Default cap on emitted windows, so one far-future reset can't explode the output. */
export const DEFAULT_WAVE_MAX_WINDOWS = 24;

export interface WavesOptions {
  /** Window width in ms (default {@link DEFAULT_WAVE_WINDOW_MS}). Must be > 0. */
  windowMs?: number;
  /** Max windows to emit (default {@link DEFAULT_WAVE_MAX_WINDOWS}). Must be >= 1. */
  maxWindows?: number;
}

/** Epoch ms of a job's reset, or NaN when missing/unparseable. */
function resetMsOf(job: RelayJob): number {
  return job.resetAt === null ? Number.NaN : Date.parse(job.resetAt);
}

/**
 * Build the resume-load histogram: bucket every `waiting_for_reset` job (with a
 * parseable `resetAt`) by which fixed relative time window it comes due in, so
 * the caller can see resume waves rather than a flat list.
 *
 * This considers exactly the set `upcoming`/`next` act on — `waiting_for_reset`
 * jobs — so the histogram never disagrees with the timeline. A job already past
 * its reset (a tick would resume it now) lands in window 0 and is also tallied
 * in `dueNow`. Jobs whose reset falls past the `maxWindows` horizon are counted
 * in `beyondHorizon` rather than distorting the last window.
 */
export function buildResumeWaves(jobs: RelayJob[], now: number = Date.now(), options: WavesOptions = {}): ResumeWaves {
  const windowMs =
    typeof options.windowMs === "number" && options.windowMs > 0 ? options.windowMs : DEFAULT_WAVE_WINDOW_MS;
  const maxWindows =
    typeof options.maxWindows === "number" && options.maxWindows >= 1
      ? Math.floor(options.maxWindows)
      : DEFAULT_WAVE_MAX_WINDOWS;

  const resets = jobs
    .filter((job) => job.status === "waiting_for_reset" && !Number.isNaN(resetMsOf(job)))
    .map(resetMsOf);

  const totalWaiting = resets.length;
  let dueNow = 0;
  let beyondHorizon = 0;
  // Sparse index→count map; we materialize the contiguous run afterwards so
  // empty windows between resumes are preserved in the histogram.
  const counts = new Map<number, number>();
  let maxIndex = -1;

  for (const resetMs of resets) {
    // A passed reset floors to a negative index; clamp it into window 0 so
    // "due now" work shows up at the front of the histogram.
    const raw = Math.floor((resetMs - now) / windowMs);
    if (resetMs <= now) dueNow++;
    const index = raw < 0 ? 0 : raw;
    if (index >= maxWindows) {
      beyondHorizon++;
      continue;
    }
    counts.set(index, (counts.get(index) ?? 0) + 1);
    if (index > maxIndex) maxIndex = index;
  }

  const windows: WaveBucket[] = [];
  let peakCount = 0;
  let peakIndex: number | null = null;
  for (let index = 0; index <= maxIndex; index++) {
    const count = counts.get(index) ?? 0;
    const startMs = now + index * windowMs;
    windows.push({ index, startMs, endMs: startMs + windowMs, offsetMs: index * windowMs, count });
    // First window to reach the max wins the tie (earliest wave is the one to act on).
    if (count > peakCount) {
      peakCount = count;
      peakIndex = index;
    }
  }

  return {
    windows,
    windowMs,
    totalWaiting,
    dueNow,
    peakCount,
    peakIndex,
    beyondHorizon,
    horizonMs: windows.length > 0 ? windows[windows.length - 1].endMs - now : 0,
  };
}
