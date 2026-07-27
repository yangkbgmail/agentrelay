import type { ControlResult } from "./control.js";
import { parseDuration } from "./prune.js";
import type { JobStatus, RelayJob } from "./types.js";

/**
 * Pure helpers for `agentrelay reschedule <id> <when>` — the human-initiated
 * transition that *changes when a pending job will resume*.
 *
 * `cancel` and `retry` are the two manual controls that already exist: `cancel`
 * stops a job for good, `retry` forces it due right now. Neither lets a user say
 * "resume this in 2 hours" or "resume at 3pm" — yet that's a real need when the
 * parser mis-read the reset time (too early → wasted resume that re-hits the
 * limit; too late → the relay sits idle longer than it has to) or when the user
 * simply wants to defer a job to off-peak hours. Rescheduling parks the job in
 * `waiting_for_reset` with a caller-chosen `resetAt`, so the scheduler picks it
 * up exactly then.
 *
 * Kept pure (like `control`/`parser`/`summary`) so the CLI can validate the
 * request and produce precise messages without touching the store.
 */

/**
 * Statuses a job can be rescheduled from: the *pending* ones. A `resuming` job
 * is mid-flight — moving its resume time would race the in-progress run — and
 * the terminal states (`completed`/`failed`/`cancelled`) have nothing left to
 * resume (use `retry` to revive one). This is intentionally narrower than
 * {@link CANCELLABLE_STATUSES}, which includes `resuming`.
 */
export const RESCHEDULABLE_STATUSES: readonly JobStatus[] = ["queued", "waiting_for_reset"];

/**
 * Whether `job` may have its resume time changed. Rejects in-flight and terminal
 * jobs with a specific reason so the CLI can explain the refusal.
 */
export function canReschedule(job: RelayJob): ControlResult {
  if (job.status === "resuming") return { ok: false, reason: "job is currently resuming; wait for it to finish" };
  if (job.status === "completed") return { ok: false, reason: "job already completed; use retry to run it again" };
  if (job.status === "failed") return { ok: false, reason: "job already failed; use retry to run it again" };
  if (job.status === "cancelled") return { ok: false, reason: "job was cancelled; use retry to run it again" };
  return { ok: true };
}

/** A successfully resolved resume time. */
export interface ResolvedResumeAt {
  /** The absolute resume time, epoch milliseconds. */
  atMs: number;
  /**
   * True when `when` was a duration from now (e.g. `2h`), false when it was an
   * absolute timestamp. Lets the CLI phrase the confirmation appropriately.
   */
  relative: boolean;
}

export type ResolveResumeAtResult = ResolvedResumeAt | { error: string };

/**
 * Resolve a user-supplied `when` into an absolute resume time. Two accepted
 * forms, disambiguated without overlap because {@link parseDuration} only
 * matches a bare `<number><unit>` (anchored) while a timestamp never carries a
 * lone duration unit:
 *
 *   - a duration from now, optionally with a leading `+`: `2h`, `30m`, `+1d`,
 *     `90s`, `500ms` → `now + duration`
 *   - an absolute time any `Date` can parse: `2026-07-28T15:00:00Z`
 *
 * A resolved time in the past is *allowed* (the job simply becomes due
 * immediately) — the CLI surfaces that rather than rejecting it, so correcting
 * an over-long detected reset is one command. Blank input or an unrecognizable
 * value returns `{ error }`.
 */
export function resolveResumeAt(when: string, nowMs: number): ResolveResumeAtResult {
  const trimmed = when.trim();
  if (!trimmed) return { error: "no resume time given" };

  // Duration form. Strip a single leading "+" (a friendly "from now" marker)
  // before handing it to parseDuration, which doesn't accept the sign.
  const durationText = trimmed.startsWith("+") ? trimmed.slice(1).trim() : trimmed;
  const durationMs = parseDuration(durationText);
  if (durationMs !== null) {
    return { atMs: nowMs + durationMs, relative: true };
  }

  // A bare number with no unit is ambiguous — the user likely meant a duration
  // but forgot the unit. Reject it rather than let `new Date` silently read it
  // as a calendar year (`new Date("3600")` → year 3600), which is never intended.
  if (/^\d+(?:\.\d+)?$/.test(durationText)) {
    return {
      error: `"${when}" needs a unit (e.g. ${durationText}s, ${durationText}m, ${durationText}h) or a full timestamp`,
    };
  }

  // Absolute-timestamp form. Only treat it as such when Date can parse it into a
  // finite instant; otherwise it's neither a duration nor a date.
  const parsed = new Date(trimmed);
  const atMs = parsed.getTime();
  if (!Number.isNaN(atMs)) {
    return { atMs, relative: false };
  }

  return {
    error: `could not read "${when}" as a duration (e.g. 2h, 30m, +1d) or a timestamp (e.g. 2026-07-28T15:00:00Z)`,
  };
}
