import { parseDuration } from "./prune.js";

/**
 * Inputs for {@link resolveScheduledResetAt}. Exactly one of `at` (an absolute
 * ISO 8601 instant) or `in` (a relative duration like `5h`/`30m`) must be
 * supplied; `now` is the reference epoch (injected so the resolution stays pure
 * and deterministic in tests).
 */
export interface ScheduleTimeInput {
  at?: string;
  in?: string;
  now: number;
}

/** A successfully resolved future reset time. */
export interface ScheduledTime {
  /** ISO 8601 string suitable for `RelayQueue.markWaitingForReset`. */
  resetAt: string;
  /** The same instant as epoch milliseconds. */
  resetAtMs: number;
}

/** A resolution failure with a human-readable reason (never thrown). */
export interface ScheduleTimeError {
  error: string;
}

export type ScheduleTimeResult = ScheduledTime | ScheduleTimeError;

/** Type guard: did {@link resolveScheduledResetAt} fail? */
export function isScheduleTimeError(result: ScheduleTimeResult): result is ScheduleTimeError {
  return (result as ScheduleTimeError).error !== undefined;
}

/**
 * Resolve the future reset time a proactively-scheduled job should first run
 * at. This is a pure companion to the reactive rate-limit path: instead of
 * waiting for the parser to observe a limit message, the user names the reset
 * time directly (`--at`/`--in`) and the daemon resumes the command when it
 * arrives -- exactly the machinery that drives `waiting_for_reset` jobs today.
 *
 * Rules:
 *  - Exactly one of `at`/`in` is required (both, or neither, is an error).
 *  - `in` parses through the shared {@link parseDuration} grammar and must be
 *    strictly positive (a zero/negative delay means "now" -- use `run` for
 *    that). The result is `now + duration`.
 *  - `at` parses as an ISO 8601 instant. A time in the past is allowed and
 *    resolves to a job that is immediately due (a deliberate "queue it now"
 *    semantic), so only an unparseable value is rejected.
 */
export function resolveScheduledResetAt(input: ScheduleTimeInput): ScheduleTimeResult {
  const hasAt = input.at !== undefined && input.at.trim() !== "";
  const hasIn = input.in !== undefined && input.in.trim() !== "";

  if (hasAt && hasIn) {
    return { error: "Provide either --at or --in, not both." };
  }
  if (!hasAt && !hasIn) {
    return { error: "Provide --at <time> or --in <duration> to schedule the run." };
  }

  if (hasIn) {
    const ms = parseDuration(input.in as string);
    if (ms === null) {
      return { error: `Invalid --in duration: "${input.in}". Use forms like 5h, 30m, or 90s.` };
    }
    if (ms <= 0) {
      return { error: "--in must be a positive duration (use `run` to start immediately)." };
    }
    const resetAtMs = input.now + ms;
    return { resetAt: new Date(resetAtMs).toISOString(), resetAtMs };
  }

  const resetAtMs = Date.parse(input.at as string);
  if (!Number.isFinite(resetAtMs)) {
    return {
      error: `Invalid --at time: "${input.at}". Use an ISO 8601 instant like 2026-08-08T02:00:00Z.`,
    };
  }
  return { resetAt: new Date(resetAtMs).toISOString(), resetAtMs };
}
