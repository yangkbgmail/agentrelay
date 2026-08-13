import type { JobStatus, RelayJob } from "@agentrelay/core";

/**
 * Client-side status filtering for the dashboard job list.
 *
 * The CLI has rich `--status` filtering (status/stats/export), but the
 * dashboard job table has always rendered *every* job — unusable once a queue
 * grows to dozens of terminal jobs. This module is the pure, framework-free
 * core of an interactive status filter: the React client owns the `active` set
 * (toggled by clicking the summary tiles) and delegates the actual filtering
 * and toggle bookkeeping here so it stays unit-testable in the `node` vitest
 * environment (no jsdom needed).
 */

/**
 * Keep only jobs whose status is in `active`.
 *
 * An empty set means "no filter" — the full list is returned unchanged (same
 * reference), so the common unfiltered path stays allocation-free. A non-empty
 * set returns a fresh, order-preserving array of the matching jobs (OR across
 * the selected statuses).
 */
export function filterJobsByStatus(jobs: RelayJob[], active: ReadonlySet<JobStatus>): RelayJob[] {
  if (active.size === 0) return jobs;
  return jobs.filter((job) => active.has(job.status));
}

/**
 * Return a new set with `status` toggled — added if absent, removed if present.
 * The input set is never mutated, so it is safe to feed React state directly
 * (`setActive((prev) => toggleStatus(prev, status))`).
 */
export function toggleStatus(active: ReadonlySet<JobStatus>, status: JobStatus): Set<JobStatus> {
  const next = new Set(active);
  if (next.has(status)) {
    next.delete(status);
  } else {
    next.add(status);
  }
  return next;
}

/** Whether any status filter is currently applied. */
export function isFilterActive(active: ReadonlySet<JobStatus>): boolean {
  return active.size > 0;
}

/**
 * Human-readable summary of the active filter, e.g. `"failed"` or
 * `"waiting for reset, failed"`. `labels` maps each status to its display
 * label (the client already has this in `STATUS_META`); `order` fixes a stable
 * left-to-right ordering so the sentence does not jump around as a `Set`'s
 * iteration order changes. Returns an empty string when no filter is active.
 */
export function describeFilter(
  active: ReadonlySet<JobStatus>,
  labels: Record<JobStatus, string>,
  order: readonly JobStatus[]
): string {
  if (active.size === 0) return "";
  return order
    .filter((status) => active.has(status))
    .map((status) => labels[status] ?? status)
    .join(", ");
}
