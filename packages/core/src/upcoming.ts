// Forward-looking agenda of upcoming resumes.
//
// Where `next` (next.ts) answers "which single job resumes soonest?" and
// `status` lists the whole queue as a flat table, neither surfaces the relay's
// central promise — *when will my parked jobs come back to life?* — as a
// scannable, time-bucketed schedule. `agentrelay upcoming` fills that gap: it
// takes every job parked in `waiting_for_reset` with a parseable reset time and
// groups them into time buckets (overdue / within the hour / later today /
// later) so an operator can see the shape of the coming resume schedule at a
// glance.
//
// Pure: computed from the job list and an injected `now` (epoch ms) — no clock,
// no queue, no I/O — so the whole command is unit-testable without a spawned
// process or a TTY.

import type { RelayJob } from "./types.js";

/** One parked job placed on the resume agenda. */
export interface ResumeAgendaEntry {
  jobId: string;
  project: string;
  tool: string;
  /** ISO reset timestamp (guaranteed parseable — non-parseable jobs are dropped). */
  resetAt: string;
  /** Milliseconds from `now` until the reset; zero/negative once it has passed. */
  dueInMs: number;
  /** True once the reset has passed — a scheduler tick would pick the job up now. */
  due: boolean;
}

/** Which time window a parked job falls into, relative to `now`. */
export type ResumeBucketKey = "overdue" | "hour" | "today" | "later";

/** A time window plus the parked jobs that fall in it (sorted soonest-first). */
export interface ResumeAgendaBucket {
  key: ResumeBucketKey;
  label: string;
  entries: ResumeAgendaEntry[];
}

/**
 * The full resume agenda. `buckets` always contains all four windows in
 * chronological order (any of them may be empty), so callers can render a
 * stable layout without re-deriving the bucket set.
 */
export interface ResumeAgenda {
  buckets: ResumeAgendaBucket[];
  /** Total parked jobs across all buckets. */
  totalWaiting: number;
  /** ISO reset of the soonest parked job, or null when nothing is waiting. */
  nextResetAt: string | null;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The bucket definitions, in the order they are rendered. */
export const RESUME_BUCKETS: ReadonlyArray<{ key: ResumeBucketKey; label: string }> = [
  { key: "overdue", label: "Overdue (due now)" },
  { key: "hour", label: "Within the hour" },
  { key: "today", label: "Later today (≤ 24h)" },
  { key: "later", label: "Later (> 24h)" },
];

/** Assign a job to a bucket by how long until its reset comes due. */
function bucketFor(dueInMs: number): ResumeBucketKey {
  if (dueInMs <= 0) return "overdue";
  if (dueInMs <= HOUR_MS) return "hour";
  if (dueInMs <= DAY_MS) return "today";
  return "later";
}

/**
 * Order two entries by which the scheduler resumes first: earliest reset wins,
 * then oldest `createdAt` (carried on the source job), then id — fully
 * deterministic even when two jobs share a reset time. Mirrors `next.ts` so the
 * two commands agree on ordering.
 */
function compareEntries(a: ResumeAgendaEntry, b: ResumeAgendaEntry, createdAt: Map<string, string>): number {
  const ra = Date.parse(a.resetAt);
  const rb = Date.parse(b.resetAt);
  if (ra !== rb) return ra - rb;
  const ca = createdAt.get(a.jobId) ?? "";
  const cb = createdAt.get(b.jobId) ?? "";
  if (ca !== cb) return ca < cb ? -1 : 1;
  if (a.jobId === b.jobId) return 0;
  return a.jobId < b.jobId ? -1 : 1;
}

/**
 * Build the resume agenda from the job list. Considers only jobs parked in
 * `waiting_for_reset` with a parseable `resetAt` — exactly the set the
 * scheduler's due logic acts on — so `upcoming` reflects what the daemon will
 * actually do, without duplicating the queue. Jobs missing or with an
 * unparseable `resetAt` are dropped (they can't be placed on a timeline).
 */
export function buildResumeAgenda(jobs: RelayJob[], now: number = Date.now()): ResumeAgenda {
  const createdAt = new Map<string, string>();
  const entries: ResumeAgendaEntry[] = [];

  for (const job of jobs) {
    if (job.status !== "waiting_for_reset" || job.resetAt === null) continue;
    const resetMs = Date.parse(job.resetAt);
    if (Number.isNaN(resetMs)) continue;
    createdAt.set(job.id, job.createdAt);
    entries.push({
      jobId: job.id,
      project: job.project,
      tool: job.tool,
      resetAt: job.resetAt,
      dueInMs: resetMs - now,
      due: resetMs <= now,
    });
  }

  entries.sort((a, b) => compareEntries(a, b, createdAt));

  const byBucket = new Map<ResumeBucketKey, ResumeAgendaEntry[]>();
  for (const def of RESUME_BUCKETS) byBucket.set(def.key, []);
  for (const entry of entries) {
    // biome-ignore lint/style/noNonNullAssertion: every bucket key is seeded above.
    byBucket.get(bucketFor(entry.dueInMs))!.push(entry);
  }

  const buckets: ResumeAgendaBucket[] = RESUME_BUCKETS.map((def) => ({
    key: def.key,
    label: def.label,
    // biome-ignore lint/style/noNonNullAssertion: every bucket key is seeded above.
    entries: byBucket.get(def.key)!,
  }));

  return {
    buckets,
    totalWaiting: entries.length,
    nextResetAt: entries.length > 0 ? entries[0].resetAt : null,
  };
}
