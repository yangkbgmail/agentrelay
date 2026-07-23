import type { JobStatus, RelayJob } from "./types.js";

/**
 * One distinct failure reason and the jobs that hit it. Jobs are grouped by a
 * normalized {@link errorSignature} of their `lastError`, so near-identical
 * failures (differing only in trailing whitespace, wrapping, or a multi-line
 * stack tail) collapse into a single row you can act on.
 */
export interface ErrorGroup {
  /** The normalized signature shared by every job in this group. */
  signature: string;
  /** How many jobs failed with this signature. */
  count: number;
  /** Ids of the jobs in this group, in first-seen order (feed to `agentrelay show`). */
  jobIds: string[];
  /** Distinct statuses present in this group, first-seen order (usually just `failed`). */
  statuses: JobStatus[];
  /** The full, untruncated `lastError` of the first job in the group, for context. */
  sample: string;
}

/**
 * A ranked breakdown of why jobs failed, so `agentrelay errors` can answer the
 * relay's most operational question: "what's actually killing my resumes?".
 */
export interface ErrorBreakdown {
  /** Jobs considered — those carrying a non-empty `lastError`. */
  totalWithErrors: number;
  /** Number of distinct error signatures ({@link groups}.length, kept for JSON). */
  distinctSignatures: number;
  /** Error groups ranked by count (desc), ties broken by signature (asc). */
  groups: ErrorGroup[];
}

/** Cap a signature's length so one pathological long line can't dominate output. */
const MAX_SIGNATURE_LENGTH = 200;

/**
 * Normalize a raw `lastError` into a stable grouping key: take the first
 * non-empty line, collapse internal whitespace runs to single spaces, and cap
 * the length. Returns `null` when the error is missing or only whitespace — such
 * a job carries no actionable failure reason and is excluded from the breakdown.
 *
 * Pure: no I/O, no ambient state. The first line is used because agent failures
 * are typically a headline reason followed by a stack/context tail that varies
 * per run; grouping on the headline keeps like failures together.
 */
export function errorSignature(raw: string | null): string | null {
  if (raw === null) return null;
  // First non-empty line (handles CRLF and leading blank lines).
  let firstLine = "";
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length > 0) {
      firstLine = line;
      break;
    }
  }
  const collapsed = firstLine.trim().replace(/\s+/g, " ");
  if (collapsed.length === 0) return null;
  if (collapsed.length <= MAX_SIGNATURE_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_SIGNATURE_LENGTH - 1)}…`;
}

/**
 * Groups a job list by the normalized signature of each job's `lastError` and
 * ranks the groups by frequency, so the most common failure reason surfaces
 * first. Pure and non-mutating. Jobs with no actionable error (null or
 * whitespace-only `lastError`) are skipped and don't count toward
 * `totalWithErrors`. Insertion order within a group is preserved so `sample`
 * and `jobIds[0]` are deterministic.
 */
export function computeErrorBreakdown(jobs: RelayJob[]): ErrorBreakdown {
  const buckets = new Map<string, ErrorGroup>();
  let totalWithErrors = 0;

  for (const job of jobs) {
    const signature = errorSignature(job.lastError);
    if (signature === null) continue;
    totalWithErrors += 1;

    const existing = buckets.get(signature);
    if (existing) {
      existing.count += 1;
      existing.jobIds.push(job.id);
      if (!existing.statuses.includes(job.status)) existing.statuses.push(job.status);
    } else {
      buckets.set(signature, {
        signature,
        count: 1,
        jobIds: [job.id],
        statuses: [job.status],
        // The sample is the first job's raw error verbatim, so callers can show
        // the untruncated original alongside the collapsed signature.
        sample: job.lastError ?? signature,
      });
    }
  }

  const groups = [...buckets.values()].sort((a, b) =>
    b.count !== a.count ? b.count - a.count : a.signature.localeCompare(b.signature)
  );

  return { totalWithErrors, distinctSignatures: groups.length, groups };
}
