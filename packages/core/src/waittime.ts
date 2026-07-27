import type { RelayJob } from "./types.js";

/**
 * Fleet-level view of the wall-clock rate-limit wait AgentRelay absorbed on the
 * user's behalf, built from the {@link RateLimitDetection} provenance persisted
 * on each job's `lastRateLimit`. This is AgentRelay's core value stated as a
 * number: every parked job had a stretch between when a limit was detected
 * (`detectedAt`) and when it reset (`resetAt`) that the relay sat through so the
 * user didn't have to babysit. Summed across the queue, that's the unattended
 * wait the tool handled — the headline "so you didn't have to" figure.
 *
 * Distinct from `stats` resolution time (a job's whole createdAt→updatedAt
 * lifecycle) and from `patterns`/`errors` (which pattern fired / why it failed):
 * this measures *time waited for resets*, nothing else.
 */
export interface WaitTimeStats {
  /** Total jobs considered (after any scope filter the caller applied). */
  total: number;
  /** Jobs carrying a well-formed, non-negative wait span (see {@link computeWaitTime}). */
  withWait: number;
  /** Jobs with no usable wait span (never rate-limited, or unparseable provenance). */
  withoutWait: number;
  /** Sum of every counted wait span, in milliseconds. */
  totalWaitMs: number;
  /** Mean wait span over `withWait` jobs, or null when none qualify. */
  avgWaitMs: number | null;
  /** Shortest counted wait span (ms), or null when none qualify. */
  minWaitMs: number | null;
  /** Longest counted wait span (ms), or null when none qualify. */
  maxWaitMs: number | null;
  /** Id of the job with the longest wait — a drill-down handle for `agentrelay show`. */
  longestJobId: string | null;
}

/** Epoch ms of an ISO timestamp, or null when missing/unparseable. */
function parseMs(iso: string | undefined | null): number | null {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Aggregates the persisted `lastRateLimit` provenance across a job list into the
 * total rate-limit wait AgentRelay absorbed, for `agentrelay waited`. Pure and
 * non-mutating: no I/O, no ambient clock — every span is computed from the
 * detection's own `detectedAt` and `resetAt`, never a wall clock.
 *
 * A job contributes a span only when it carries a `lastRateLimit` whose
 * `detectedAt` and `resetAt` both parse to valid timestamps and whose span
 * (`resetAt − detectedAt`) is non-negative. A negative span (clock skew, or a
 * reset already in the past at detection) is dropped rather than clamped, so a
 * bad record can't inflate the total. Everything else — no detection, missing or
 * malformed timestamps — is counted as `withoutWait`.
 *
 * Because each job carries only its *last* detection, this counts one wait per
 * job: a job re-parked by a later limit overwrote its own earlier provenance
 * (we track current state, not full history), so the true absorbed wait can be
 * an underestimate for jobs rate-limited more than once.
 */
export function computeWaitTime(jobs: RelayJob[]): WaitTimeStats {
  let withWait = 0;
  let totalWaitMs = 0;
  let minWaitMs: number | null = null;
  let maxWaitMs: number | null = null;
  let longestJobId: string | null = null;

  for (const job of jobs) {
    const detection = job.lastRateLimit;
    if (!detection) continue;
    const detectedMs = parseMs(detection.detectedAt);
    const resetMs = parseMs(detection.resetAt);
    if (detectedMs === null || resetMs === null) continue;
    const span = resetMs - detectedMs;
    if (span < 0) continue;

    withWait += 1;
    totalWaitMs += span;
    if (minWaitMs === null || span < minWaitMs) minWaitMs = span;
    // `>` (not `>=`) keeps the *first* job at the max, a stable tiebreak.
    if (maxWaitMs === null || span > maxWaitMs) {
      maxWaitMs = span;
      longestJobId = job.id;
    }
  }

  return {
    total: jobs.length,
    withWait,
    withoutWait: jobs.length - withWait,
    totalWaitMs,
    avgWaitMs: withWait > 0 ? Math.round(totalWaitMs / withWait) : null,
    minWaitMs,
    maxWaitMs,
    longestJobId,
  };
}
