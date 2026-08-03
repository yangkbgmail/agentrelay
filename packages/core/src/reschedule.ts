// Pure time-resolution for `agentrelay reschedule <id> <when>` — move a pending
// job's resume time by hand. Where `retry` forces a job to run *now* and resets
// its attempt budget, and `cancel` calls it off entirely, `reschedule` answers
// the middle case: the job is still waiting, but its parsed reset time is wrong
// (the parser guessed a window it shouldn't have, or the user simply wants to
// defer the resume to a quieter hour). This corrects *when*, nothing else —
// attempts and last error are left untouched by the queue method that consumes
// the resolved time.
//
// The parsing here is a pure function of the input string and an injected `now`
// so the CLI can unit-test the "30m" / "2h" / ISO-timestamp / "now" cases
// without a clock or a store.

import { parseDuration } from "./prune.js";

export interface RescheduleTimeResult {
  /** The resolved absolute resume time as an ISO timestamp (only when ok). */
  at?: string;
  /** Present only when the input could not be understood. */
  error?: string;
}

/**
 * Resolve a user-supplied `<when>` into an absolute ISO resume time.
 *
 * Accepted forms, tried in this order:
 *   - `now` (any case) or `0` → resume immediately (`now`).
 *   - a relative duration understood by {@link parseDuration}
 *     (`30m`, `2h`, `1d`, `90s`, `500ms`) → `now` plus that long.
 *   - an absolute timestamp any `Date` can parse (ISO 8601 recommended,
 *     e.g. `2026-08-04T05:00:00Z`).
 *
 * A past absolute time (or `now`) is allowed and means "due immediately" — the
 * scheduler resumes it on the next tick. Anything else returns an `error` with
 * guidance rather than guessing. Pure: `now` is injected for deterministic tests.
 */
export function resolveRescheduleTime(input: string, now: Date): RescheduleTimeResult {
  const raw = input.trim();
  if (!raw) return { error: "no time given" };

  // "now" / "0" → resume immediately. Handled first because `new Date("0")` is
  // platform-dependent and `parseDuration("0")` is null (it needs a unit).
  if (/^now$/i.test(raw) || raw === "0") {
    return { at: now.toISOString() };
  }

  // Relative duration from now.
  const durationMs = parseDuration(raw);
  if (durationMs !== null) {
    return { at: new Date(now.getTime() + durationMs).toISOString() };
  }

  // Absolute timestamp (ISO 8601 or anything Date understands).
  const absolute = new Date(raw);
  if (!Number.isNaN(absolute.getTime())) {
    return { at: absolute.toISOString() };
  }

  return {
    error: `could not understand time "${raw}" — use a duration like 30m/2h/1d, "now", or an ISO timestamp (e.g. 2026-08-04T05:00:00Z)`,
  };
}
