import type { ControlResult } from "./control.js";
import { parseDuration } from "./prune.js";
import type { JobStatus, RelayJob } from "./types.js";

/**
 * Pure helpers for `agentrelay reschedule` — the human-initiated transition that
 * sits between `retry` (resume *now*) and `cancel` (resume *never*): move a
 * pending job's reset time to a *specific* moment.
 *
 * This fills a real gap. The parser occasionally reads the wrong reset time out
 * of an agent's rate-limit message (an unusual timezone phrasing, a "resets at
 * 5pm" the machine's clock disagrees with), and until now the only recourse was
 * `retry` (which resumes immediately, possibly re-hitting the limit) or `cancel`
 * (which drops the work). Rescheduling lets the operator correct the reset time
 * or deliberately defer a job, keeping its attempt count and error history.
 *
 * Kept pure (no clock, no store) — mirrors how `control`/`parser` stay testable
 * without a filesystem or a spawned process; the queue and CLI own the I/O.
 */

/**
 * Statuses `reschedule` can act on: a job that is queued or parked waiting for a
 * reset. In-flight (`resuming`) and terminal (`completed`/`failed`/`cancelled`)
 * jobs are excluded — there is nothing to re-time about them.
 */
export const RESCHEDULABLE_STATUSES: readonly JobStatus[] = ["queued", "waiting_for_reset"];

/**
 * Whether `job` may have its reset time changed. Rejects in-flight and terminal
 * jobs with a precise reason (mirroring {@link canCancel}/{@link canRequeue}),
 * so the CLI can explain the refusal without touching the store. A `cancelled`
 * job is steered toward `retry`, which is the transition that actually revives
 * it.
 */
export function canReschedule(job: RelayJob): ControlResult {
  if (job.status === "resuming") return { ok: false, reason: "job is currently resuming; wait for it to finish" };
  if (job.status === "completed") return { ok: false, reason: "job already completed" };
  if (job.status === "failed") return { ok: false, reason: "job already failed" };
  if (job.status === "cancelled") return { ok: false, reason: "job is cancelled; use retry to run it again" };
  return { ok: true };
}

/** A resolved reschedule time, or the reason the input could not be parsed. */
export type RescheduleTime = { resetAt: string } | { error: string };

/**
 * Turn a user-supplied `when` into an absolute ISO reset time. Two forms are
 * accepted:
 *
 * - A **duration** relative to `now`, optionally prefixed with `+`:
 *   `30m`, `+2h`, `1d`, `90s`, `500ms` (reuses {@link parseDuration}, so the
 *   grammar matches `--older-than`/`--since` everywhere else in the CLI).
 * - An **absolute timestamp** parseable by `Date.parse`, e.g.
 *   `2026-08-05T15:00:00Z`.
 *
 * A time in the past (a `0s` duration or an already-elapsed timestamp) is
 * allowed and simply makes the job due immediately — that is the operator's
 * explicit choice. Pure: `now` is injectable so tests need no ambient clock.
 */
export function resolveRescheduleTime(input: string, now: number = Date.now()): RescheduleTime {
  const raw = input.trim();
  if (!raw) return { error: "no time given" };

  // Duration form (optionally written as `+30m`) is relative to `now`.
  const durationText = raw.startsWith("+") ? raw.slice(1).trim() : raw;
  const ms = parseDuration(durationText);
  if (ms !== null) return { resetAt: new Date(now + ms).toISOString() };

  // Otherwise interpret it as an absolute timestamp.
  const abs = Date.parse(raw);
  if (Number.isFinite(abs)) return { resetAt: new Date(abs).toISOString() };

  return {
    error: `could not parse time "${input}" — use a duration (e.g. 30m, 2h, 1d) or an ISO timestamp (e.g. 2026-08-05T15:00:00Z)`,
  };
}
