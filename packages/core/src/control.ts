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
