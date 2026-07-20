import type { HeartbeatFacts } from "./doctor.js";
import type { HeartbeatMode } from "./heartbeat.js";

/**
 * Resume-loop liveness, distilled from the daemon/tick {@link HeartbeatFacts}.
 *
 * AgentRelay only auto-resumes a job when its rate-limit window resets, and that
 * only happens if a resume loop (`agentrelay daemon`, or a cron-scheduled
 * `agentrelay tick`) is actually running. `doctor` already surfaces this on the
 * CLI; this module factors the *judgment* out of `doctor` into a pure function
 * so other surfaces — the local dashboard, in particular — can show the same
 * "is anything going to pick my waiting jobs up?" signal without duplicating the
 * staleness reasoning.
 *
 * Pure, no I/O and no clock: callers assemble {@link HeartbeatFacts} (reading the
 * file and diffing against the wall clock) and hand them here, exactly as
 * `doctor` does. That keeps the read-the-file half in the app/CLI layer and the
 * classify half here, testable in isolation.
 */

/**
 * The three liveness verdicts:
 * - `alive` — a recent heartbeat: a resume loop is running and will pick up jobs.
 * - `stale` — a heartbeat exists but hasn't ticked within its staleness window;
 *   the loop probably stopped (crash, killed, cron misconfigured).
 * - `absent` — no usable heartbeat at all: no resume loop has run.
 */
export type ResumeLoopState = "alive" | "stale" | "absent";

/** A dashboard-friendly liveness snapshot of the resume loop. */
export interface ResumeLoopStatus {
  /** Liveness verdict — see {@link ResumeLoopState}. */
  state: ResumeLoopState;
  /**
   * True when this state should worry the user: jobs are waiting to resume but
   * no live loop will pick them up (i.e. `state !== "alive"` while
   * `waitingCount > 0`). An `alive` loop is never a concern; a `stale`/`absent`
   * loop with nothing waiting is harmless — there's nothing to resume.
   */
  concern: boolean;
  /** Jobs currently waiting to resume (queued/waiting_for_reset/resuming), echoed for the message. */
  waitingCount: number;
  /** How the writer runs (only when a heartbeat is present). */
  mode?: HeartbeatMode;
  /** Writer PID, so the UI can point the user at the process. */
  pid?: number;
  /** Age (ms) of the last tick, when known. */
  ageMs?: number;
  /** Staleness threshold (ms) the age was judged against, when known. */
  staleAfterMs?: number;
}

/**
 * True when a heartbeat proves a *currently running* resume loop: it's present,
 * has a known age and staleness window, and the age is within that window. This
 * is the single "is the loop alive right now?" rule, shared by `doctor` and the
 * dashboard so the two never drift.
 */
export function isHeartbeatAlive(facts: HeartbeatFacts): boolean {
  return (
    facts.present && facts.ageMs !== undefined && facts.staleAfterMs !== undefined && facts.ageMs <= facts.staleAfterMs
  );
}

/**
 * Classifies {@link HeartbeatFacts} plus how many jobs are waiting into a
 * {@link ResumeLoopStatus}. `waitingCount` is sanitized (negatives / NaN /
 * fractional inputs are coerced to a non-negative integer) so a caller passing a
 * raw count never yields a nonsensical status.
 */
export function resumeLoopStatus(facts: HeartbeatFacts, waitingCount: number): ResumeLoopStatus {
  const waiting = Number.isFinite(waitingCount) ? Math.max(0, Math.trunc(waitingCount)) : 0;

  let state: ResumeLoopState;
  if (!facts.present) state = "absent";
  else if (isHeartbeatAlive(facts)) state = "alive";
  else state = "stale";

  return {
    state,
    concern: state !== "alive" && waiting > 0,
    waitingCount: waiting,
    mode: facts.mode,
    pid: facts.pid,
    ageMs: facts.ageMs,
    staleAfterMs: facts.staleAfterMs,
  };
}
