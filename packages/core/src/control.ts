import { parseDuration } from "./prune.js";
import type { JobStatus, RelayJob } from "./types.js";

/**
 * Manual job-control helpers for `agentrelay cancel` / `agentrelay retry`.
 *
 * The queue already knows how to move jobs between states as the scheduler
 * relays them; these pure functions add the *human-initiated* transitions:
 * calling off a job that's still pending, or forcing a finished job to run
 * again right now. Keeping the guard logic here (rather than inside the
 * mutating queue methods) mirrors how `parser`/`summary` stay pure and lets
 * the CLI produce precise error messages without touching the store.
 */

export interface ControlResult {
  ok: boolean;
  /** Present only when `ok` is false — a human-readable reason. */
  reason?: string;
}

/** Statuses a job has not yet finished from, i.e. that `cancel` can act on. */
export const CANCELLABLE_STATUSES: readonly JobStatus[] = ["queued", "waiting_for_reset", "resuming"];

/**
 * Whether `job` may be cancelled. Terminal jobs (`completed`/`failed`) and
 * already-`cancelled` ones are rejected — there's nothing left to stop.
 */
export function canCancel(job: RelayJob): ControlResult {
  if (job.status === "cancelled") return { ok: false, reason: "job is already cancelled" };
  if (job.status === "completed") return { ok: false, reason: "job already completed" };
  if (job.status === "failed") return { ok: false, reason: "job already failed" };
  return { ok: true };
}

/**
 * Whether `job` may be requeued to run again immediately. Any job can be
 * retried except one that's mid-flight (`resuming`) — requeuing it under the
 * scheduler would race the in-progress run.
 */
export function canRequeue(job: RelayJob): ControlResult {
  if (job.status === "resuming") return { ok: false, reason: "job is currently resuming; wait for it to finish" };
  return { ok: true };
}

/** Statuses a job can be rescheduled from — pending work whose wake time isn't fixed yet. */
export const RESCHEDULABLE_STATUSES: readonly JobStatus[] = ["queued", "waiting_for_reset"];

/**
 * Whether `job`'s resume time may be moved with `agentrelay reschedule`. Unlike
 * {@link canRequeue} (which forces an immediate rerun and resets the attempt
 * counter), rescheduling only nudges *when* a still-pending job wakes up, so it
 * accepts exactly the states that represent scheduled-but-not-yet-run work:
 * `queued` and `waiting_for_reset`. Mid-flight (`resuming`) jobs are rejected to
 * avoid racing the running command, and terminal jobs
 * (`completed`/`failed`/`cancelled`) have nothing left to schedule.
 */
export function canReschedule(job: RelayJob): ControlResult {
  if (job.status === "resuming") return { ok: false, reason: "job is currently resuming; wait for it to finish" };
  if (job.status === "completed") return { ok: false, reason: "job already completed" };
  if (job.status === "failed") return { ok: false, reason: "job already failed" };
  if (job.status === "cancelled") return { ok: false, reason: "job is cancelled" };
  return { ok: true };
}

/** The outcome of parsing a user-supplied reschedule target (see {@link resolveResetAt}). */
export interface ResetAtResult {
  /** ISO timestamp the job should next be due — present only on success. */
  resetAt?: string;
  /** Present only when parsing failed — an explanatory message. */
  error?: string;
}

/**
 * Resolve a user-supplied "when" into an absolute ISO reset timestamp, for
 * `agentrelay reschedule <id> <when>`. Two forms are accepted:
 *
 * - A **relative** duration from now, optionally prefixed with `+`: `30m`,
 *   `+2h`, `1d`, `90s`. Reuses the same {@link parseDuration} grammar the rest
 *   of the tool uses (`ms`/`s`/`m`/`h`/`d`, single unit).
 * - An **absolute** instant: any string `Date` can parse, e.g. an ISO 8601
 *   timestamp `2026-07-28T10:00:00Z`.
 *
 * Relative is tried first so bare durations never get misread as dates. A pure
 * function — `nowMs` is injected rather than read from the clock — so the CLI
 * stays testable. Returns an `error` (never throws) for anything it can't
 * interpret, and rejects a resolved time in the past so a typo can't silently
 * make a job due immediately.
 */
export function resolveResetAt(input: string, nowMs: number): ResetAtResult {
  const raw = input.trim();
  if (!raw) return { error: "no time given — use a duration like 30m/2h/1d or an absolute ISO timestamp" };

  const relative = raw.startsWith("+") ? raw.slice(1).trim() : raw;
  const durationMs = parseDuration(relative);
  if (durationMs !== null) {
    return { resetAt: new Date(nowMs + durationMs).toISOString() };
  }

  const absoluteMs = Date.parse(raw);
  if (!Number.isNaN(absoluteMs)) {
    if (absoluteMs < nowMs) {
      return { error: `"${raw}" is in the past — use a future time, or "agentrelay retry" to resume now` };
    }
    return { resetAt: new Date(absoluteMs).toISOString() };
  }

  return { error: `could not understand "${raw}" — use a duration like 30m/2h/1d or an absolute ISO timestamp` };
}

/** One job that a bulk-control guard rejected, paired with the reason why. */
export interface IneligibleJob {
  job: RelayJob;
  reason: string;
}

/**
 * The result of splitting a job list into those a guard accepts and those it
 * rejects. Used by `agentrelay cancel --all` / `retry --all` to act on every
 * eligible job while reporting precisely why the rest were left alone.
 */
export interface BulkControlSelection {
  /** Jobs the guard accepts — these will be acted on. */
  eligible: RelayJob[];
  /** Jobs the guard rejects, each with a human-readable reason. */
  ineligible: IneligibleJob[];
}

/**
 * Partition `jobs` into the ones a control guard ({@link canCancel} /
 * {@link canRequeue}) accepts and the ones it rejects. Pure and non-mutating:
 * the input order is preserved and no job is copied. Callers scope the list
 * first (by status/tool/project/time) and then use this to apply the guard,
 * so the same guards drive both the single-id and bulk paths.
 */
export function partitionForControl(jobs: RelayJob[], guard: (job: RelayJob) => ControlResult): BulkControlSelection {
  const eligible: RelayJob[] = [];
  const ineligible: IneligibleJob[] = [];
  for (const job of jobs) {
    const result = guard(job);
    if (result.ok) eligible.push(job);
    else ineligible.push({ job, reason: result.reason ?? "not eligible" });
  }
  return { eligible, ineligible };
}

export interface ResolveIdResult {
  /** The full job id when exactly one job matched. */
  id?: string;
  /** Present only when resolution failed — an explanatory message. */
  error?: string;
}

/**
 * Resolve a user-supplied id — either a full UUID or a short prefix (the
 * `status` table shows the first 8 chars) — to exactly one job. Ambiguous or
 * unknown inputs return an `error` instead of guessing.
 */
export function resolveJobId(jobs: RelayJob[], idOrPrefix: string): ResolveIdResult {
  const needle = idOrPrefix.trim();
  if (!needle) return { error: "no job id given" };

  const exact = jobs.find((job) => job.id === needle);
  if (exact) return { id: exact.id };

  const matches = jobs.filter((job) => job.id.startsWith(needle));
  if (matches.length === 1) return { id: matches[0].id };
  if (matches.length === 0) return { error: `no job matches id "${needle}"` };
  return { error: `id "${needle}" is ambiguous — matches ${matches.length} jobs; use more characters` };
}
