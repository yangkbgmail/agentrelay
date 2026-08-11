import type { AgentTool, RelayJob } from "./types.js";

/**
 * Per-tool slice of the relay-savings report: how many jobs of a given agent
 * tool carried a bridged rate-limit window, and the total unattended wait the
 * relay covered for them.
 */
export interface SavingsToolStat {
  tool: AgentTool;
  /** Jobs of this tool that contributed a usable bridged window. */
  jobs: number;
  /** Total bridged wait (ms) across those jobs. */
  bridgedMs: number;
}

/**
 * The headline value AgentRelay delivers, quantified: every time a job is
 * parked in `waiting_for_reset`, the relay sits out the rate-limit window and
 * auto-resumes the moment it clears — *unattended* time a human would otherwise
 * have had to babysit and manually restart across. This report sums that
 * bridged wait across the queue.
 *
 * The bridged window of a single job is `resetAt − detectedAt` from its
 * persisted `lastRateLimit` provenance (see {@link RelayJob.lastRateLimit}):
 * the gap between when the rate limit was detected and when it lifted. Each job
 * carries only its *most recent* detection, so this is a conservative
 * lower-bound — a job re-parked several times contributes only its last
 * window, not the cumulative total. That mirrors `agentrelay patterns`, which
 * reads the same current-state provenance rather than a full history.
 */
export interface RelaySavings {
  /** Total jobs considered (after any scope filter the caller applied). */
  total: number;
  /** Jobs carrying a usable bridged window (parseable detectedAt≤resetAt). */
  bridged: number;
  /** Sum of every bridged window (ms) — the unattended wait the relay covered. */
  totalBridgedMs: number;
  /** Mean bridged window (ms) across the `bridged` jobs; 0 when none. */
  averageBridgeMs: number;
  /** The single longest bridged window (ms); 0 when none. */
  longestBridgeMs: number;
  /** Id of the job that owns {@link longestBridgeMs}; null when none. */
  longestBridgeJobId: string | null;
  /** Per-tool breakdown, ranked by bridgedMs (desc), ties broken by tool name (asc). */
  byTool: SavingsToolStat[];
}

/** Epoch ms of an ISO string, or NaN when missing/unparseable. */
function parseMs(iso: unknown): number {
  return typeof iso === "string" ? Date.parse(iso) : Number.NaN;
}

/**
 * Compute the relay's cumulative "unattended wait bridged" report from the
 * per-job `lastRateLimit` provenance. Pure and non-mutating: no I/O, no ambient
 * clock — the bridged window reads each detection's own `detectedAt`/`resetAt`,
 * never a wall clock, so the result is fully reproducible and unit-testable.
 *
 * A job contributes only when its `lastRateLimit` carries both a parseable
 * `detectedAt` and `resetAt` with `resetAt ≥ detectedAt`. A malformed pair
 * (missing, unparseable, or reset-before-detection) is skipped rather than
 * counted as a zero or negative window, so bad records never inflate — or
 * deflate — the total.
 */
export function computeRelaySavings(jobs: RelayJob[]): RelaySavings {
  const toolBuckets = new Map<AgentTool, SavingsToolStat>();
  let bridged = 0;
  let totalBridgedMs = 0;
  let longestBridgeMs = 0;
  let longestBridgeJobId: string | null = null;

  for (const job of jobs) {
    const detection = job.lastRateLimit;
    if (!detection) continue;
    const detectedMs = parseMs(detection.detectedAt);
    const resetMs = parseMs(detection.resetAt);
    if (Number.isNaN(detectedMs) || Number.isNaN(resetMs)) continue;
    const windowMs = resetMs - detectedMs;
    if (windowMs < 0) continue;

    bridged += 1;
    totalBridgedMs += windowMs;
    // The first bridged job always becomes the current holder (so a queue whose
    // only detections are zero-length windows still names one); a strictly
    // larger window later takes over.
    if (longestBridgeJobId === null || windowMs > longestBridgeMs) {
      longestBridgeMs = windowMs;
      longestBridgeJobId = job.id;
    }

    const existing = toolBuckets.get(job.tool);
    if (!existing) {
      toolBuckets.set(job.tool, { tool: job.tool, jobs: 1, bridgedMs: windowMs });
    } else {
      existing.jobs += 1;
      existing.bridgedMs += windowMs;
    }
  }

  const byTool = [...toolBuckets.values()].sort((a, b) =>
    b.bridgedMs !== a.bridgedMs ? b.bridgedMs - a.bridgedMs : a.tool.localeCompare(b.tool)
  );

  return {
    total: jobs.length,
    bridged,
    totalBridgedMs,
    averageBridgeMs: bridged > 0 ? totalBridgedMs / bridged : 0,
    longestBridgeMs,
    longestBridgeJobId,
    byTool,
  };
}
