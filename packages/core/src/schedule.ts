import { parseDuration } from "./prune.js";

/**
 * Pure time-resolution for `agentrelay schedule` — proactively parking a command
 * so the daemon runs it later, without first having to run it and hit a live
 * rate limit.
 *
 * Every other way a job enters the queue is *reactive*: `agentrelay run` spawns
 * the command, scans its output, and only enqueues it once a rate-limit message
 * is actually detected. That's the wrong shape when you already *know* when your
 * window reopens ("my Claude limit resets at 15:00, queue the follow-up now") or
 * when you simply want the relay to fire a command at a set time and auto-retry
 * it on rate limits. `schedule` fills that gap by parking a job directly in the
 * `waiting_for_reset` state with a chosen `resetAt`, so the existing resume loop
 * (`listDue` → resume) picks it up at the right moment — reusing the whole
 * scheduler/retry machinery, not a second execution path.
 *
 * This module owns only the *when*: turning `--in <duration>` / `--at <time>`
 * into an absolute ISO reset timestamp. It is pure (the caller injects `now`),
 * so the parsing rules are unit-testable without a queue or a clock.
 */

export interface ScheduleTimeInput {
  /** Relative delay from now, e.g. "2h", "30m", "1d" (see {@link parseDuration}). */
  in?: string;
  /**
   * Absolute time. Accepts an ISO 8601 datetime (`2026-08-21T15:00:00Z`), any
   * other `Date`-parseable string, or a bare unix epoch — 10 digits = seconds,
   * 13 digits = milliseconds (the same epoch forms the rate-limit parser emits).
   */
  at?: string;
}

export interface ScheduleTimeResult {
  /** The resolved absolute reset time, ISO 8601. */
  resetAt: string;
  /** The resolved reset time in epoch milliseconds. */
  resetMs: number;
  /**
   * True when the resolved time is at or before `now`, so the job is already due
   * and the next daemon/tick will resume it immediately. Not an error — a
   * legitimate "run this through the relay as soon as possible" request — but the
   * CLI surfaces it so the user isn't surprised by an instant fire.
   */
  immediate: boolean;
}

/** A whole (optionally signed) run of 10 or 13 digits — a unix epoch, s or ms. */
const EPOCH_RE = /^(\d{10}|\d{13})$/;

/**
 * Resolve the target reset time from the mutually-exclusive `--in`/`--at`
 * options. Throws an {@link Error} with an actionable message for any unusable
 * input (both given, neither given, unparseable duration/time), which the CLI
 * turns into a clean exit-1 — mirroring how the other commands report bad flags.
 */
export function resolveScheduleTime(input: ScheduleTimeInput, now: Date = new Date()): ScheduleTimeResult {
  const hasIn = input.in !== undefined && input.in.trim() !== "";
  const hasAt = input.at !== undefined && input.at.trim() !== "";

  if (hasIn && hasAt) {
    throw new Error("Pass only one of --in or --at, not both.");
  }
  if (!hasIn && !hasAt) {
    throw new Error("Specify when to run: --in <duration> (e.g. 2h) or --at <time> (e.g. an ISO 8601 timestamp).");
  }

  let resetMs: number;
  if (hasIn) {
    // biome-ignore lint/style/noNonNullAssertion: hasIn guarantees input.in is set.
    const offsetMs = parseDuration(input.in!);
    if (offsetMs === null) {
      throw new Error(`Invalid --in duration: "${input.in}". Use forms like 30m, 2h, 1d, 90s.`);
    }
    resetMs = now.getTime() + offsetMs;
  } else {
    // biome-ignore lint/style/noNonNullAssertion: hasAt guarantees input.at is set.
    resetMs = parseAbsoluteTime(input.at!);
  }

  return {
    resetAt: new Date(resetMs).toISOString(),
    resetMs,
    immediate: resetMs <= now.getTime(),
  };
}

/** Parse an `--at` value to epoch ms; throws on anything unrecognizable. */
function parseAbsoluteTime(raw: string): number {
  const at = raw.trim();
  const epoch = EPOCH_RE.exec(at);
  if (epoch) {
    // 10 digits = seconds, 13 = milliseconds.
    return at.length === 10 ? Number(at) * 1000 : Number(at);
  }
  const ms = new Date(at).getTime();
  if (Number.isNaN(ms)) {
    throw new Error(
      `Invalid --at time: "${raw}". Use an ISO 8601 timestamp (e.g. 2026-08-21T15:00:00Z) or a unix epoch.`
    );
  }
  return ms;
}
