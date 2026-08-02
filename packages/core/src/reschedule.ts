import type { ControlResult } from "./control.js";
import { parseDuration } from "./prune.js";
import type { JobStatus, RelayJob } from "./types.js";

/**
 * Manual "when should this job next become due" correction for
 * `agentrelay reschedule`.
 *
 * The parser guesses a reset time from the agent's rate-limit message, but that
 * guess can be wrong (a fuzzy "try again later", a clock-skewed host, a message
 * format the patterns round the wrong way). `retry` only knows one target —
 * *now* — and it also wipes the attempt count. Rescheduling is the missing
 * middle ground: point a pending job at a *specific* future (or immediate) time
 * without pretending it's a fresh run. Kept pure here (no clock, no store) so
 * the CLI can validate input and craft precise errors, mirroring how
 * `control`/`summary` stay side-effect free.
 */

/**
 * Statuses whose due-time may be rescheduled: jobs that are still pending but
 * not mid-flight. `resuming` is excluded (rescheduling it would race the
 * in-progress run — same reasoning as {@link canRequeue}), and the terminal
 * states have no "next due" to move — use `retry` to bring those back.
 */
export const RESCHEDULABLE_STATUSES: readonly JobStatus[] = ["queued", "waiting_for_reset"];

/**
 * Whether `job`'s due time may be rescheduled. Rejects in-flight and terminal
 * jobs with an explanatory reason so the CLI can print exactly why.
 */
export function canReschedule(job: RelayJob): ControlResult {
  if (job.status === "resuming") {
    return { ok: false, reason: "job is currently resuming; wait for it to finish" };
  }
  if (RESCHEDULABLE_STATUSES.includes(job.status)) return { ok: true };
  return {
    ok: false,
    reason: `job is ${job.status}; only ${RESCHEDULABLE_STATUSES.join("/")} jobs can be rescheduled (use retry to requeue a finished job)`,
  };
}

/** A successfully parsed reschedule target. */
export interface RescheduleTime {
  /** ISO timestamp the job should next become due at. */
  at: string;
  /**
   * How the input was interpreted, for a clearer confirmation line:
   * `now` (immediate), `duration` (relative to now), or `absolute` (a timestamp).
   */
  kind: "now" | "duration" | "absolute";
}

/** A rejected reschedule target, with a human-readable reason. */
export interface RescheduleTimeError {
  error: string;
}

/**
 * Interpret a user-supplied `when` into an ISO reset timestamp, relative to
 * `nowMs`. Accepted forms, tried in this order so a duration is never
 * mis-read as a date:
 *
 * - `now` (case-insensitive) → due immediately.
 * - A duration like `2h`, `90m`, `1d`, `30s`, `500ms` → `now + duration`.
 * - An ISO 8601 (or otherwise `Date.parse`-able) timestamp → that absolute time.
 *
 * A time in the past is allowed and means "due immediately" — `listDue` picks
 * up any `waiting_for_reset` job whose `resetAt` is at or before now. Anything
 * unrecognised returns an `error` rather than guessing.
 */
export function parseRescheduleWhen(input: string, nowMs: number): RescheduleTime | RescheduleTimeError {
  const raw = input.trim();
  if (!raw) return { error: "no time given" };

  if (raw.toLowerCase() === "now") {
    return { at: new Date(nowMs).toISOString(), kind: "now" };
  }

  const durationMs = parseDuration(raw);
  if (durationMs !== null) {
    return { at: new Date(nowMs + durationMs).toISOString(), kind: "duration" };
  }

  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) {
    return { at: new Date(parsed).toISOString(), kind: "absolute" };
  }

  return {
    error: `could not understand time "${input}" — use "now", a duration like 2h/90m/1d, or an ISO 8601 timestamp`,
  };
}

/** Narrowing helper: whether a {@link parseRescheduleWhen} result is an error. */
export function isRescheduleTimeError(result: RescheduleTime | RescheduleTimeError): result is RescheduleTimeError {
  return "error" in result;
}
