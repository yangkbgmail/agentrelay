import type { ControlResult } from "./control.js";
import { parseDuration } from "./prune.js";
import type { JobStatus, RelayJob } from "./types.js";

/**
 * Manual reschedule helpers for `agentrelay reschedule` — human-initiated
 * correction of *when* a parked job should resume.
 *
 * The rate-limit parser only ever *guesses* the reset time from an agent's
 * message, and that guess can be wrong (an ambiguous "resets at 3pm" with no
 * date/zone, a provider that lies, a clock skew). Cancelling and re-running
 * loses the captured command/output; `retry` forces the job due *now* and
 * wipes its attempt budget. Neither lets a user say "actually the reset is at
 * <time>, keep waiting until then." This module fills that gap: it resolves a
 * user `<when>` token into an absolute reset instant and guards which jobs may
 * be moved. Kept pure (like `control`/`summary`) so the CLI can produce precise
 * errors without touching the store or an ambient clock.
 */

/** Statuses whose reset time can be manually corrected or deferred. */
export const RESCHEDULABLE_STATUSES: readonly JobStatus[] = ["queued", "waiting_for_reset"];

/**
 * Whether `job`'s resume time may be manually rescheduled. Terminal jobs
 * (`completed`/`failed`/`cancelled`) have nothing left to wait for, and an
 * in-flight (`resuming`) job would race the running command — all rejected
 * with an explanatory reason. A `queued` job (enqueued but not yet run) is
 * allowed: rescheduling it simply defers the first run.
 */
export function canReschedule(job: RelayJob): ControlResult {
  if (job.status === "resuming") return { ok: false, reason: "job is currently resuming; wait for it to finish" };
  if (job.status === "completed") return { ok: false, reason: "job already completed" };
  if (job.status === "failed") return { ok: false, reason: "job already failed" };
  if (job.status === "cancelled") return { ok: false, reason: "job is cancelled" };
  return { ok: true };
}

export interface ResolveRescheduleResult {
  /** The resolved reset time as an ISO 8601 string (only when parsing succeeds). */
  resetAt?: string;
  /** Present only on failure — a human-readable reason. */
  error?: string;
}

/**
 * Resolve a user-supplied `<when>` token into an absolute ISO reset timestamp.
 * Three forms are accepted:
 *
 *   - `now`            → due immediately (`resetAt` = `nowMs`)
 *   - `+<duration>`    → `nowMs` + duration, e.g. `+30m`, `+2h`, `+90s`, `+1d`
 *                        (reuses {@link parseDuration}, so the same unit set as
 *                        `--since`/`prune`)
 *   - ISO 8601 stamp   → an absolute instant, e.g. `2026-07-30T15:00:00Z`
 *
 * Relative offsets and `now` are anchored to `nowMs` so the function stays pure
 * and testable. Anything else returns an `error` (rather than guessing) so the
 * CLI can point the user at the accepted forms.
 */
export function resolveRescheduleAt(when: string, nowMs: number = Date.now()): ResolveRescheduleResult {
  const raw = when.trim();
  if (!raw) {
    return { error: "no time given — use `now`, `+<duration>` (e.g. +30m), or an ISO 8601 timestamp" };
  }

  if (raw.toLowerCase() === "now") {
    return { resetAt: new Date(nowMs).toISOString() };
  }

  if (raw.startsWith("+")) {
    const ms = parseDuration(raw.slice(1));
    if (ms === null) {
      return { error: `could not parse duration "${raw}" — try +30m, +2h, +90s, or +1d` };
    }
    return { resetAt: new Date(nowMs + ms).toISOString() };
  }

  // Otherwise treat it as an absolute timestamp. Require it to actually parse
  // as a date; a bare duration without the leading `+` (e.g. "30m") falls
  // through to here and is rejected with a hint toward the relative form.
  const parsedMs = Date.parse(raw);
  if (Number.isNaN(parsedMs)) {
    return {
      error: `could not parse "${raw}" as a time — use \`now\`, \`+<duration>\` (e.g. +30m), or an ISO 8601 timestamp`,
    };
  }
  return { resetAt: new Date(parsedMs).toISOString() };
}
