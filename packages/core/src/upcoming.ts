import type { RelayJob } from "./types.js";

/**
 * A forward-looking resume schedule: how the jobs still waiting for a rate-limit
 * reset spread out over time. Where `next` answers "which single job resumes
 * soonest?" and `status` prints a flat table, this buckets the whole waiting set
 * into a small, fixed set of time windows so `agentrelay upcoming` answers the
 * planning-level question "how backed up is the relay, and when will it clear?".
 *
 * Pure and clock-injectable (all timing comes from the passed `now`, never an
 * ambient `Date.now()` inside the classification), so the buckets are unit
 * testable end to end.
 */

/** The four time windows a waiting job falls into, in chronological order. */
export type ResumeBucketKey = "overdue" | "within_hour" | "within_day" | "later";

/** Upper boundary (exclusive) of the "within 1 hour" window, in ms. */
export const WITHIN_HOUR_MS = 60 * 60_000;
/** Upper boundary (exclusive) of the "within 24 hours" window, in ms. */
export const WITHIN_DAY_MS = 24 * WITHIN_HOUR_MS;

/** Fixed bucket order + human labels, so callers and tests share one source of truth. */
export const RESUME_BUCKETS: ReadonlyArray<{ key: ResumeBucketKey; label: string }> = [
  { key: "overdue", label: "due now" },
  { key: "within_hour", label: "within 1 hour" },
  { key: "within_day", label: "within 24 hours" },
  { key: "later", label: "beyond 24 hours" },
];

/** One time window of the schedule: how many jobs land in it and the soonest one. */
export interface ResumeBucket {
  key: ResumeBucketKey;
  label: string;
  /** Jobs whose reset falls in this window. */
  count: number;
  /** ISO reset time of the soonest job in this window, or null when the bucket is empty. */
  earliestResetAt: string | null;
  /** Ms from `now` to that soonest reset; ≤0 for the overdue bucket. Null when empty. */
  earliestDueInMs: number | null;
}

/** The full schedule: the four buckets plus queue-wide totals. */
export interface ResumeSchedule {
  /** The `now` the schedule was computed against (epoch ms), echoed for callers. */
  now: number;
  /** Total jobs waiting for a reset with a parseable `resetAt` (the sum of all bucket counts). */
  totalWaiting: number;
  /** ISO reset time of the overall soonest waiting job, or null when nothing is waiting. */
  nextResetAt: string | null;
  /** Always the four {@link RESUME_BUCKETS}, in chronological order (empty ones included). */
  buckets: ResumeBucket[];
}

/** Classify a positive/zero "due in" delay into its time window. */
function bucketFor(dueInMs: number): ResumeBucketKey {
  if (dueInMs <= 0) return "overdue";
  if (dueInMs < WITHIN_HOUR_MS) return "within_hour";
  if (dueInMs < WITHIN_DAY_MS) return "within_day";
  return "later";
}

/**
 * Group the jobs waiting for a reset into the fixed set of time windows. The
 * waiting set is exactly the scheduler's resume set — `waiting_for_reset` jobs
 * with a parseable `resetAt` — so this stays in step with what `next`/the
 * daemon act on (active and terminal jobs are ignored). Buckets are always
 * present (empty ones included) and in chronological order; within each, the
 * soonest reset is surfaced for a representative countdown.
 */
export function computeResumeSchedule(jobs: RelayJob[], now: number = Date.now()): ResumeSchedule {
  // Seed every bucket so the output shape is stable regardless of which windows
  // happen to be populated.
  const acc = new Map<ResumeBucketKey, { count: number; earliestMs: number | null }>();
  for (const { key } of RESUME_BUCKETS) acc.set(key, { count: 0, earliestMs: null });

  let totalWaiting = 0;
  let overallEarliestMs: number | null = null;

  for (const job of jobs) {
    if (job.status !== "waiting_for_reset" || job.resetAt === null) continue;
    const resetMs = Date.parse(job.resetAt);
    if (Number.isNaN(resetMs)) continue;

    totalWaiting += 1;
    if (overallEarliestMs === null || resetMs < overallEarliestMs) overallEarliestMs = resetMs;

    const slot = acc.get(bucketFor(resetMs - now));
    // `slot` is always defined: bucketFor only returns seeded keys.
    if (!slot) continue;
    slot.count += 1;
    if (slot.earliestMs === null || resetMs < slot.earliestMs) slot.earliestMs = resetMs;
  }

  const buckets: ResumeBucket[] = RESUME_BUCKETS.map(({ key, label }) => {
    const slot = acc.get(key) ?? { count: 0, earliestMs: null };
    return {
      key,
      label,
      count: slot.count,
      earliestResetAt: slot.earliestMs === null ? null : new Date(slot.earliestMs).toISOString(),
      earliestDueInMs: slot.earliestMs === null ? null : slot.earliestMs - now,
    };
  });

  return {
    now,
    totalWaiting,
    nextResetAt: overallEarliestMs === null ? null : new Date(overallEarliestMs).toISOString(),
    buckets,
  };
}
