import type { RelayJob } from "./types.js";

/**
 * Resume-batching helpers for the scheduler.
 *
 * When a rate-limit window resets, *every* job that was waiting on that window
 * becomes due in the same instant. `RelayScheduler.tick` would then re-run all
 * of them back-to-back — and if they share a provider account, that burst tends
 * to trip the very limit that just reset (a "thundering herd"). Capping how many
 * jobs a single tick resumes spreads the burst across successive ticks: the
 * un-resumed jobs stay `waiting_for_reset` with a past `resetAt`, so the next
 * tick simply picks them up.
 *
 * These functions are pure and non-mutating so the scheduler wiring and the
 * tests share exactly the selection/ordering rules.
 */

/**
 * Compare two due jobs for resume ordering: **most overdue first**. The job
 * whose reset time passed longest ago goes first, so a cap never lets a
 * long-waiting job starve behind newer arrivals. Ties (identical `resetAt`) are
 * broken by `createdAt` (FIFO), then by `id` for a fully deterministic order.
 *
 * A `null` `resetAt` shouldn't reach here (only `waiting_for_reset` jobs with a
 * concrete reset time are due), but is treated as "infinitely overdue" (sorted
 * first) rather than throwing, so a malformed job can't wedge the batch.
 */
export function compareResumeOrder(a: RelayJob, b: RelayJob): number {
  const at = a.resetAt === null ? Number.NEGATIVE_INFINITY : Date.parse(a.resetAt);
  const bt = b.resetAt === null ? Number.NEGATIVE_INFINITY : Date.parse(b.resetAt);
  // Unparseable timestamps behave like "unknown, treat as most overdue" too.
  const av = Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
  const bv = Number.isNaN(bt) ? Number.NEGATIVE_INFINITY : bt;
  if (av !== bv) return av - bv;
  const ac = Date.parse(a.createdAt);
  const bc = Date.parse(b.createdAt);
  const acv = Number.isNaN(ac) ? 0 : ac;
  const bcv = Number.isNaN(bc) ? 0 : bc;
  if (acv !== bcv) return acv - bcv;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Pick the jobs to resume this tick from all currently-due jobs, honoring an
 * optional per-tick cap.
 *
 * - `limit` `undefined`, `null`, `0` or negative → **no cap**: every due job is
 *   returned (a fresh, order-normalized array).
 * - a positive `limit` → the most-overdue `limit` jobs (see
 *   {@link compareResumeOrder}); the rest wait for a later tick.
 *
 * Always returns a new array and never mutates `due`. A non-integer positive
 * limit is floored (e.g. `2.9` → 2) so a stray fractional env value can't over-
 * or under-count.
 */
export function selectResumeBatch(due: RelayJob[], limit?: number | null): RelayJob[] {
  const ordered = [...due].sort(compareResumeOrder);
  if (limit === undefined || limit === null || !Number.isFinite(limit) || limit <= 0) {
    return ordered;
  }
  return ordered.slice(0, Math.floor(limit));
}

/**
 * Read the per-tick resume cap from the environment
 * (`AGENTRELAY_MAX_RESUMES_PER_TICK`). Returns the positive integer when set to
 * one, or `undefined` (no cap) when unset, non-numeric, or not a positive
 * integer — mirroring the "a typo must not silently change behavior" stance of
 * the other `*FromEnv` helpers, here erring toward *no* throttle so a bad value
 * never accidentally stalls the relay to one job per tick.
 */
export function maxResumesPerTickFromEnv(env: Record<string, string | undefined> = process.env): number | undefined {
  const raw = env.AGENTRELAY_MAX_RESUMES_PER_TICK?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}
