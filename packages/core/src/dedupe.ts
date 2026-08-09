import type { AgentTool, JobStatus, RelayJob } from "./types.js";

/**
 * Duplicate-job detection for `agentrelay dedupe`.
 *
 * Each `agentrelay run` mints a *new* job (a fresh UUID), so re-running the same
 * rate-limited command — a double-tap, a wrapper script fired twice, two shells
 * kicking off the same task — leaves two identical jobs queued for resume. The
 * scheduler will then dutifully run the same command twice when the window
 * reopens, which is wasteful at best and, for non-idempotent commands, wrong.
 *
 * These pure functions find those collisions so the CLI can cancel the
 * redundant copies. "Identical" means same tool + working directory + command
 * argv — the three things that determine what will actually be spawned. Jobs are
 * grouped by that identity; any group with more than one active member yields a
 * single keeper and the rest as removable duplicates. Everything here is pure
 * (no clock, no queue, no I/O) so the selection is fully unit-testable; the CLI
 * layer does the cancelling.
 */

/**
 * Statuses considered "active" for de-duplication: jobs the scheduler still
 * intends to run. `resuming` is deliberately excluded — it's mid-flight, and
 * cancelling it would race the in-progress run — as are all terminal statuses
 * (`completed`/`failed`/`cancelled`), which spawn nothing and so can't collide.
 */
export const DEDUPE_STATUSES: readonly JobStatus[] = ["queued", "waiting_for_reset"];

/**
 * The identity of what a job will actually spawn: its tool, working directory,
 * and full command argv. Two jobs with the same key resume to the exact same
 * process, so at most one of them needs to stay queued. Uses `JSON.stringify`
 * so array-valued `command` compares element-by-element and the key stays a
 * stable, groupable string.
 */
export function dedupeKey(job: RelayJob): string {
  return JSON.stringify([job.tool, job.cwd, job.command]);
}

/** A set of identical active jobs: one keeper plus the duplicates to remove. */
export interface DuplicateGroup {
  /** The shared identity key (see {@link dedupeKey}). */
  key: string;
  /** Tool/cwd/command shared by every job in the group (from the keeper). */
  tool: AgentTool;
  cwd: string;
  command: string[];
  /** The single job kept — resumes soonest (see {@link planDedupe}). */
  keep: RelayJob;
  /** The redundant jobs a dedupe pass would cancel, in keeper-preference order. */
  duplicates: RelayJob[];
}

/** The full de-duplication plan over a job list. */
export interface DedupePlan {
  /** One entry per identity that has more than one active job. */
  groups: DuplicateGroup[];
  /** Total duplicate jobs across all groups (the number that would be cancelled). */
  duplicateCount: number;
  /** How many active jobs were scanned before grouping. */
  scannedCount: number;
}

/** Options for {@link planDedupe}. */
export interface DedupeOptions {
  /**
   * Which statuses count as active candidates. Defaults to
   * {@link DEDUPE_STATUSES} (`queued` + `waiting_for_reset`). Widen it only
   * deliberately — including `resuming` risks cancelling an in-flight run.
   */
  statuses?: readonly JobStatus[];
}

/**
 * Effective "resumes at" epoch-ms used to pick a group's keeper: a parseable
 * `resetAt`, or `-Infinity` for a `queued` job (no reset time = due now =
 * soonest). Unparseable reset times sort last (`+Infinity`) so a job with a
 * broken timestamp is never preferred as the keeper.
 */
function effectiveResume(job: RelayJob): number {
  if (job.resetAt === null) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(job.resetAt);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/**
 * Order jobs within a duplicate group by keeper preference (best keeper first):
 * the one that will resume soonest, then — as a tie-break — the most recently
 * created (freshest intent), then id ascending for full determinism. Keeping the
 * soonest-resuming copy means the identical task still completes as early as
 * possible while the redundant later copies are dropped.
 */
function compareKeeperPreference(a: RelayJob, b: RelayJob): number {
  const ra = effectiveResume(a);
  const rb = effectiveResume(b);
  if (ra !== rb) return ra - rb;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Build the de-duplication plan: group active jobs by {@link dedupeKey}, and for
 * every group with more than one member, keep the soonest-resuming job and mark
 * the rest as duplicates. Pure and non-mutating — the input list is untouched.
 *
 * Groups are returned in descending duplicate-count order (the biggest pile-ups
 * first), then by keeper id for determinism, so the noisiest collision is
 * reported at the top.
 */
export function planDedupe(jobs: RelayJob[], options: DedupeOptions = {}): DedupePlan {
  const statuses = new Set(options.statuses ?? DEDUPE_STATUSES);
  const active = jobs.filter((job) => statuses.has(job.status));

  const byKey = new Map<string, RelayJob[]>();
  for (const job of active) {
    const key = dedupeKey(job);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(job);
    else byKey.set(key, [job]);
  }

  const groups: DuplicateGroup[] = [];
  let duplicateCount = 0;
  for (const [key, bucket] of byKey) {
    if (bucket.length < 2) continue;
    const ordered = [...bucket].sort(compareKeeperPreference);
    const [keep, ...duplicates] = ordered;
    duplicateCount += duplicates.length;
    groups.push({ key, tool: keep.tool, cwd: keep.cwd, command: keep.command, keep, duplicates });
  }

  groups.sort((a, b) => {
    if (a.duplicates.length !== b.duplicates.length) return b.duplicates.length - a.duplicates.length;
    return a.keep.id < b.keep.id ? -1 : a.keep.id > b.keep.id ? 1 : 0;
  });

  return { groups, duplicateCount, scannedCount: active.length };
}
