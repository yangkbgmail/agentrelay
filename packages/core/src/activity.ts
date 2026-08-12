import type { RelayJob } from "./types.js";

/**
 * What the most-recent thing that happened to a job was, distilled to one line.
 * A job's `updatedAt` moves every time the relay touches it (queued, parked for
 * a reset, resumed, completed, failed), but the store keeps no event log — only
 * the *latest* error, rate-limit detection, and captured output tail. The
 * activity feed reconstructs a "what changed, and why" line from those fields so
 * `agentrelay logs` can answer "what has the relay been doing lately?" without a
 * separate history store.
 *
 * Priority (most to least actionable): a recorded failure reason, then the
 * rate-limit detection that parked the job, then the tail of its last output,
 * then nothing. Exactly one kind is chosen per job.
 */
export type ActivityReasonKind = "error" | "rate-limit" | "output" | "none";

/** The one-line reason distilled for a job (see {@link ActivityReasonKind}). */
export interface ActivityReason {
  kind: ActivityReasonKind;
  /** Compact, single-line, whitespace-collapsed text (empty only when kind is "none"). */
  text: string;
}

/** One row of the activity feed: a job, when it last changed, and why. */
export interface ActivityEntry {
  job: RelayJob;
  /** `updatedAt` as epoch ms, or `null` when it can't be parsed (sorts last). */
  updatedMs: number | null;
  reason: ActivityReason;
}

/**
 * A reverse-chronological feed of the jobs whose state most recently changed,
 * newest first. Complements `errors` (groups failures by reason), `upcoming`
 * (looks forward at pending resumes), and `status` (creation order): this one
 * is the timeline of what just happened.
 */
export interface ActivityFeed {
  /** Rows after any `limit` is applied (newest first). */
  entries: ActivityEntry[];
  /** Total jobs considered, before `limit`. */
  total: number;
  /** How many rows are in {@link entries} (`min(total, limit)`). */
  shown: number;
  /** How many rows a `limit` hid (`total - shown`). */
  hidden: number;
}

/** Cap a reason line so one pathological long output can't dominate the feed. */
const MAX_REASON_LENGTH = 140;

/** First non-empty line of a multi-line string, whitespace-collapsed and capped. */
function firstLine(raw: string): string {
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length > 0) return cap(line.trim().replace(/\s+/g, " "));
  }
  return "";
}

/** Last non-empty line of a multi-line string, whitespace-collapsed and capped. */
function lastLine(raw: string): string {
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim().length > 0) return cap(lines[i].trim().replace(/\s+/g, " "));
  }
  return "";
}

/** Truncate with an ellipsis so no reason line exceeds {@link MAX_REASON_LENGTH}. */
function cap(s: string): string {
  return s.length <= MAX_REASON_LENGTH ? s : `${s.slice(0, MAX_REASON_LENGTH - 1)}…`;
}

/**
 * Distil a job's latest state change into one actionable line. Pure. The
 * priority order mirrors what a human debugging the relay looks for first: the
 * failure reason if there is one, else why the job is waiting (the rate-limit
 * detection), else a hint of what it last printed, else nothing.
 */
export function activityReason(job: RelayJob): ActivityReason {
  const error = job.lastError !== null ? firstLine(job.lastError) : "";
  if (error.length > 0) return { kind: "error", text: error };

  const rl = job.lastRateLimit;
  if (rl) {
    return { kind: "rate-limit", text: `rate-limited (${rl.pattern}) → resets ${rl.resetAt}` };
  }

  const output = job.lastOutputTail !== null ? lastLine(job.lastOutputTail) : "";
  if (output.length > 0) return { kind: "output", text: output };

  return { kind: "none", text: "" };
}

/**
 * Build the reverse-chronological activity feed from a job list. Pure and
 * non-mutating. Jobs are sorted by `updatedAt` descending (newest first); rows
 * whose `updatedAt` can't be parsed sink to the bottom, and ties (including two
 * jobs touched in the same millisecond) break by id ascending so the order is
 * deterministic regardless of the input order. A positive `limit` keeps the
 * newest N rows and reports the rest as `hidden`.
 */
export function buildActivityFeed(jobs: RelayJob[], options: { limit?: number } = {}): ActivityFeed {
  const entries: ActivityEntry[] = jobs.map((job) => {
    const ms = Date.parse(job.updatedAt);
    return { job, updatedMs: Number.isNaN(ms) ? null : ms, reason: activityReason(job) };
  });

  entries.sort((a, b) => {
    if (a.updatedMs === null && b.updatedMs === null) return a.job.id.localeCompare(b.job.id);
    if (a.updatedMs === null) return 1; // a (unparseable) sorts after b
    if (b.updatedMs === null) return -1;
    if (a.updatedMs !== b.updatedMs) return b.updatedMs - a.updatedMs; // newest first
    return a.job.id.localeCompare(b.job.id);
  });

  const total = entries.length;
  const limit = options.limit;
  const shownEntries = limit !== undefined && limit >= 0 ? entries.slice(0, limit) : entries;
  return { entries: shownEntries, total, shown: shownEntries.length, hidden: total - shownEntries.length };
}
