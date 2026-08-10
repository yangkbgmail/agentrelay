import { parseDuration } from "./prune.js";

/**
 * Time resolution for `agentrelay reschedule <id> <when>` — turning a
 * user-supplied "when" string into the absolute epoch-ms a job should next
 * resume at.
 *
 * The scheduler already parses rate-limit *messages* into reset times; this is
 * the *human-initiated* counterpart: an operator who wants to defer a resume
 * ("give the limit more room, +2h"), pull it forward ("resume now"), or pin it
 * to a known reset instant ("2026-08-10T15:00:00Z"). Keeping the parsing here
 * (pure, clock-injected) mirrors how `parser`/`control` stay testable without
 * touching the store or the wall clock.
 */

export interface ResumeTimeResult {
  /** Absolute epoch milliseconds to resume at (only when parsing succeeded). */
  atMs?: number;
  /** Present only when the input could not be parsed — a human-readable reason. */
  error?: string;
}

/**
 * Resolve a `<when>` argument to an absolute epoch-ms, relative to `nowMs`.
 *
 * Accepted forms (checked in order):
 * - `now` or `0` → resume immediately (`nowMs`).
 * - A duration from now: `2h`, `30m`, `90s`, `500ms`, `1d`, optionally with a
 *   leading `+` (`+2h`) to make the "from now" intent explicit.
 * - An absolute timestamp anything `Date.parse` accepts (ISO 8601 preferred,
 *   e.g. `2026-08-10T15:00:00Z`).
 *
 * A past result is allowed — it simply means "due now", which the scheduler
 * picks up on the next tick. Unrecognised input returns an `error` instead of
 * guessing, so the CLI can refuse rather than silently mis-schedule.
 */
export function resolveResumeTime(when: string, nowMs: number): ResumeTimeResult {
  const raw = when.trim();
  if (!raw) return { error: "no time given" };

  const lower = raw.toLowerCase();
  if (lower === "now" || raw === "0") return { atMs: nowMs };

  // Relative offset. A leading `+` is optional sugar for "from now"; a bare
  // duration means the same thing. parseDuration requires a unit, so plain
  // integers/ISO strings fall through to the absolute branch below.
  const relative = raw.startsWith("+") ? raw.slice(1).trim() : raw;
  const durationMs = parseDuration(relative);
  if (durationMs !== null) return { atMs: nowMs + durationMs };

  // A bare number carries no unit, so its intent is ambiguous — and Date.parse
  // would silently read it as a year ("500" → year 500). Reject it outright and
  // point the user at a unit rather than mis-scheduling far in the past.
  if (/^\d+(?:\.\d+)?$/.test(relative)) {
    return {
      error: `ambiguous time "${when}" — add a unit (e.g. ${relative}m or ${relative}h) or use an ISO timestamp`,
    };
  }

  // Absolute instant. Date.parse returns NaN for anything it can't read.
  const absolute = Date.parse(raw);
  if (!Number.isNaN(absolute)) return { atMs: absolute };

  return {
    error: `could not parse time "${when}" — use a duration (e.g. 2h, 30m), "now", or an ISO timestamp`,
  };
}
