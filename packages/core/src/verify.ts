import { validateJobRecord } from "./import.js";
import type { RelayJob } from "./types.js";

/**
 * Store-integrity linting — the missing safety net between {@link ../import}
 * (which validates records *entering* the store) and the live queue (which,
 * for speed, casts the on-disk JSON straight to `RelayJob[]` **without**
 * per-record validation — see `queue.ts`'s `load()`).
 *
 * That cast is deliberate but leaky: a hand-edited `jobs.json`, a botched
 * merge, or a record written by an older/newer build can leave the store
 * structurally loadable (a JSON array) yet semantically broken — a bogus
 * `status`, an empty `command`, negative `attempts`, or two records sharing an
 * `id`. `agentrelay doctor` only checks whole-file corruption and active
 * counts, so none of these surface until the scheduler mis-behaves at 3am:
 * a duplicate `id` makes the queue's `Map` silently drop the earlier job, and
 * a `waiting_for_reset` job with no `resetAt` can never be resumed.
 *
 * `verifyStore` closes that gap. It takes the **raw** parsed array (not the
 * queue's post-cast view, which has already collapsed duplicate ids) and
 * reports every problem at once, so the whole store can be checked in one pass
 * and wired as a CI/pre-flight gate. Everything here is pure — bytes in via the
 * CLI, judgements out — so it's trivially testable and never touches the disk.
 */

/** Severity of a store issue. `error` = the record is unusable or data is being
 *  lost; `warning` = it loads but the relay may mis-handle it. */
export type StoreIssueLevel = "error" | "warning";

/** One problem found with a single record (or a cross-record conflict). */
export interface StoreIssue {
  level: StoreIssueLevel;
  /** 0-based position of the offending record in the store array. */
  index: number;
  /** The record's `id` when it has a string one, else null (malformed record). */
  jobId: string | null;
  /** Short, stable machine-readable code (for scripts/CI). */
  code: string;
  /** Human-readable explanation of the problem. */
  message: string;
}

/** Outcome of verifying a whole store array. */
export interface StoreVerification {
  /** Number of records inspected. */
  total: number;
  /** How many records passed structural validation ({@link validateJobRecord}). */
  validJobs: number;
  /** Count of `error`-level issues. */
  errorCount: number;
  /** Count of `warning`-level issues. */
  warningCount: number;
  /** True when there are no `error`-level issues (warnings are tolerated). */
  ok: boolean;
  /** Every issue found, ordered by record index then by discovery order. */
  issues: StoreIssue[];
}

/** True when `value` parses as a date (mirrors the `Date.parse` + `Number.isNaN`
 *  convention used across stats/heartbeat). */
function isParseableDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

/**
 * Pull an `id` off a raw (possibly malformed) record for issue attribution,
 * without asserting the whole record is valid. Returns null when there's no
 * string `id` to show.
 */
function rawId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
}

/**
 * Lint a raw store array (the JSON `JSON.parse`d off disk) for integrity
 * problems. Never throws. Two layers of checks:
 *
 *  1. **Structural** (error) — each record must pass {@link validateJobRecord}:
 *     an object with a string `id`/`project`/`cwd`/timestamps, a known
 *     `tool`/`status`, a non-empty string `command` array, and a non-negative
 *     integer `attempts`. A failure means the queue would carry a job its
 *     renderers/scheduler can't reason about.
 *  2. **Cross-record & semantic** (on structurally-valid records):
 *     - duplicate `id` (**error**) — the queue keys jobs by id in a `Map`, so a
 *       second record with the same id silently *replaces* the first: the
 *       earlier job is lost the moment the store is loaded.
 *     - `waiting_for_reset` with `resetAt === null` (**warning**) — the
 *       scheduler has no time to wait for, so the job is stranded.
 *     - a non-null `resetAt` that isn't a parseable date (**warning**).
 *     - `createdAt`/`updatedAt` that aren't parseable dates (**warning**).
 *     - `updatedAt` earlier than `createdAt` (**warning**, clock skew).
 */
export function verifyStore(records: unknown[]): StoreVerification {
  const issues: StoreIssue[] = [];
  let validJobs = 0;
  // id -> the index of the first structurally-valid record that claimed it.
  const firstSeen = new Map<string, number>();

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const result = validateJobRecord(record);

    if (!result.ok) {
      issues.push({
        level: "error",
        index,
        jobId: rawId(record),
        code: "invalid-record",
        message: result.reason,
      });
      // Can't run semantic checks on a record we couldn't validate.
      continue;
    }

    validJobs++;
    const job: RelayJob = result.job;

    const prior = firstSeen.get(job.id);
    if (prior !== undefined) {
      issues.push({
        level: "error",
        index,
        jobId: job.id,
        code: "duplicate-id",
        message: `duplicate id "${job.id}" (also at record ${prior}); the queue keeps only the last, dropping the earlier job`,
      });
    } else {
      firstSeen.set(job.id, index);
    }

    if (job.status === "waiting_for_reset" && job.resetAt === null) {
      issues.push({
        level: "warning",
        index,
        jobId: job.id,
        code: "waiting-without-reset",
        message: "status is waiting_for_reset but resetAt is null; the scheduler has no time to resume it",
      });
    }

    if (job.resetAt !== null && !isParseableDate(job.resetAt)) {
      issues.push({
        level: "warning",
        index,
        jobId: job.id,
        code: "unparseable-resetAt",
        message: `resetAt "${job.resetAt}" is not a parseable date`,
      });
    }

    const createdOk = isParseableDate(job.createdAt);
    const updatedOk = isParseableDate(job.updatedAt);
    if (!createdOk) {
      issues.push({
        level: "warning",
        index,
        jobId: job.id,
        code: "unparseable-createdAt",
        message: `createdAt "${job.createdAt}" is not a parseable date`,
      });
    }
    if (!updatedOk) {
      issues.push({
        level: "warning",
        index,
        jobId: job.id,
        code: "unparseable-updatedAt",
        message: `updatedAt "${job.updatedAt}" is not a parseable date`,
      });
    }
    if (createdOk && updatedOk && Date.parse(job.updatedAt) < Date.parse(job.createdAt)) {
      issues.push({
        level: "warning",
        index,
        jobId: job.id,
        code: "clock-skew",
        message: "updatedAt is earlier than createdAt (clock skew)",
      });
    }
  }

  const errorCount = issues.reduce((n, issue) => n + (issue.level === "error" ? 1 : 0), 0);
  const warningCount = issues.length - errorCount;

  return {
    total: records.length,
    validJobs,
    errorCount,
    warningCount,
    ok: errorCount === 0,
    issues,
  };
}
