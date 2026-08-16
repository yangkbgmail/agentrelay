import { jobResolutionMs } from "./stats.js";
import type { RelayJob } from "./types.js";

/**
 * The relay's payoff, quantified: what AgentRelay actually did *for* you.
 *
 * The whole product exists so a rate-limited agent run doesn't strand until a
 * human notices and re-launches it at reset time. This aggregate answers the
 * "was it worth it?" question directly — how many manual restarts the relay
 * absorbed, and how much wall-clock it carried unattended — from nothing but
 * the job history. Pure and non-mutating: no clock, no I/O.
 *
 * Every figure is grounded in stored data, never a speculative multiplier:
 * `autoResumes` is counted from `attempts`, `unattendedMs` from lifecycle
 * spans. A caller who wants a "minutes of attention saved per restart" headline
 * can multiply `manualInterventionsSaved` by their own factor, but the core
 * stays honest and assumption-free.
 */
export interface RelayValue {
  /** Total jobs the value was computed over. */
  totalJobs: number;
  /**
   * Automatic resume attempts the relay performed on your behalf: summed across
   * jobs as `max(0, attempts − 1)`. The first attempt is the initial,
   * human-launched run; every attempt beyond it is a relay-driven resume you
   * would otherwise have kicked off by hand after a rate-limit.
   */
  autoResumes: number;
  /** Jobs the relay resumed at least once (`attempts > 1`). */
  resumedJobs: number;
  /**
   * Manual restarts the relay saved you — one per auto-resume, so numerically
   * equal to {@link autoResumes}. Named for the product story: "N times you
   * didn't have to notice a limit and re-run the command yourself."
   */
  manualInterventionsSaved: number;
  /**
   * Total wall-clock the relay carried unattended, in ms: the summed lifecycle
   * span (`updatedAt − createdAt`, via {@link jobResolutionMs}) of resolved
   * jobs (completed/failed) that were actually relayed (`attempts > 1`). This is
   * time your work kept moving toward done across a rate-limit window without
   * you watching. Jobs with a missing/unparseable timestamp or a negative span
   * (clock skew) are skipped, matching `TimingStats`. First-try successes never
   * count — the relay didn't have to step in for them.
   */
  unattendedMs: number;
  /** The single longest unattended span (ms) — the biggest one-job save. 0 when none. */
  longestUnattendedMs: number;
  /** How many resolved, relayed jobs contributed a valid span to {@link unattendedMs}. */
  unattendedJobs: number;
}

/**
 * Aggregate the relay's payoff over a job list for `agentrelay savings`. Pure
 * and non-mutating: no I/O, no ambient clock. Reuses {@link jobResolutionMs}
 * for the lifecycle span so the savings view and the timing stats agree on what
 * "how long the relay babysat a job" means.
 */
export function computeRelayValue(jobs: RelayJob[]): RelayValue {
  let autoResumes = 0;
  let resumedJobs = 0;
  let unattendedMs = 0;
  let longestUnattendedMs = 0;
  let unattendedJobs = 0;

  for (const job of jobs) {
    // attempts counts every launch, so attempts − 1 is the relay-driven resumes
    // (0 for a first-try job). Guard against a malformed 0/negative attempts.
    const resumes = Math.max(0, job.attempts - 1);
    autoResumes += resumes;
    if (resumes > 0) {
      resumedJobs += 1;
      // Only a resolved job that was actually relayed contributes unattended
      // time — a job still in flight has no final span yet, and a first-try
      // success never needed the relay.
      if (job.status === "completed" || job.status === "failed") {
        const span = jobResolutionMs(job);
        if (span !== null) {
          unattendedMs += span;
          unattendedJobs += 1;
          if (span > longestUnattendedMs) longestUnattendedMs = span;
        }
      }
    }
  }

  return {
    totalJobs: jobs.length,
    autoResumes,
    resumedJobs,
    manualInterventionsSaved: autoResumes,
    unattendedMs,
    longestUnattendedMs,
    unattendedJobs,
  };
}
