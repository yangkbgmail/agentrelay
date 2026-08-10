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

/** What kind of record a repair dropped. Both restore the store to what the
 *  queue would actually load — see {@link repairStore}. */
export type RepairActionKind = "drop-invalid" | "drop-duplicate";

/** One change a repair made (or, in a dry run, would make) to the store. */
export interface RepairAction {
  kind: RepairActionKind;
  /** 0-based position of the dropped record in the original store array. */
  index: number;
  /** The dropped record's `id` when it has a string one, else null. */
  jobId: string | null;
  /** Human-readable explanation of why the record was dropped. */
  reason: string;
}

/** Outcome of computing an error-level repair for a whole store array. */
export interface StoreRepair {
  /** The read-only lint of the *original* store (same as {@link verifyStore}). */
  verification: StoreVerification;
  /** The records to keep — every structurally-valid, non-duplicate job, in the
   *  store's original order (with earlier duplicates removed). Safe to write back. */
  kept: RelayJob[];
  /** Every record the repair dropped, ordered by original index. */
  actions: RepairAction[];
  /** True when the repair would change the store (i.e. `actions` is non-empty). */
  changed: boolean;
}

/**
 * Compute the error-level repair of a raw store array: the safe subset the queue
 * would actually keep, plus a record of what was dropped. Pure — no I/O — so the
 * CLI can preview a plan (`--dry-run`) with the exact same logic it later writes.
 *
 * Repair is **conservative and non-destructive of usable data**. It only touches
 * `error`-level problems, and only in ways that mirror what the live queue does
 * on load anyway:
 *
 *  - **invalid-record** → dropped. A record that fails {@link validateJobRecord}
 *    can't be represented as a `RelayJob`; the renderers/scheduler can't reason
 *    about it. (The CLI backs up the raw store before writing, so the bytes are
 *    never truly lost.)
 *  - **duplicate-id** → the **last** occurrence is kept, earlier ones dropped.
 *    This is exactly the queue's own load semantics (it keys jobs by id in a
 *    `Map`, so the last write wins); the earlier records are *already* dead on
 *    load, so removing them only makes the file match reality.
 *
 * `warning`-level issues (unparseable dates, `waiting_for_reset` with no
 * `resetAt`, clock skew) are **left untouched**: the correct value is unknown, so
 * guessing could hide a real problem. Records are kept byte-for-byte as parsed.
 */
export function repairStore(records: unknown[]): StoreRepair {
  const verification = verifyStore(records);

  // First pass: the last array index that each id validly claims. The queue keeps
  // the last write per id, so that's the occurrence a repair preserves.
  const lastIndexForId = new Map<string, number>();
  for (let index = 0; index < records.length; index++) {
    const result = validateJobRecord(records[index]);
    if (result.ok) lastIndexForId.set(result.job.id, index);
  }

  const kept: RelayJob[] = [];
  const actions: RepairAction[] = [];

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const result = validateJobRecord(record);

    if (!result.ok) {
      actions.push({
        kind: "drop-invalid",
        index,
        jobId: rawId(record),
        reason: result.reason,
      });
      continue;
    }

    const job = result.job;
    if (lastIndexForId.get(job.id) !== index) {
      actions.push({
        kind: "drop-duplicate",
        index,
        jobId: job.id,
        reason: `duplicate id "${job.id}"; the queue keeps the last write (record ${lastIndexForId.get(job.id)})`,
      });
      continue;
    }

    kept.push(job);
  }

  return { verification, kept, actions, changed: actions.length > 0 };
}
