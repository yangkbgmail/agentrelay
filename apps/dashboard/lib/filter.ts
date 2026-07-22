import type { JobStatus, RelayJob } from "@agentrelay/core";

/**
 * A client-side view filter for the dashboard job table. Every dimension is
 * optional; an empty filter matches everything. This mirrors the CLI's
 * `status`/`stats` scope filters (status/tool/project) and adds a free-text
 * search so the dashboard can narrow a large queue without a page reload.
 *
 * Intentionally pure and self-contained (only `import type` from core) so it can
 * run in the client bundle without pulling the node-only store code, and so it
 * stays trivially unit-testable.
 */
export interface DashboardFilter {
  /** Keep only jobs whose status is one of these (OR within the dimension). */
  statuses?: JobStatus[];
  /** Keep only jobs whose tool is one of these (matched as raw strings). */
  tools?: string[];
  /** Keep only jobs whose project is one of these (exact match). */
  projects?: string[];
  /**
   * Case-insensitive substring match over project, job id, and the joined
   * command. Whitespace-only text is treated as no search.
   */
  search?: string;
}

/** True when the filter would actually narrow anything (any dimension is set). */
export function isFilterActive(filter: DashboardFilter): boolean {
  return Boolean(
    (filter.statuses && filter.statuses.length > 0) ||
      (filter.tools && filter.tools.length > 0) ||
      (filter.projects && filter.projects.length > 0) ||
      (filter.search && filter.search.trim().length > 0)
  );
}

/**
 * Narrows a job list to those matching the filter. Dimensions combine with AND
 * (a job must pass status AND tool AND project AND search); values within a
 * dimension combine with OR. Pure and non-mutating — always returns a fresh
 * array so callers never alias the source list.
 */
export function filterJobs(jobs: RelayJob[], filter: DashboardFilter): RelayJob[] {
  let result = jobs.slice();

  if (filter.statuses && filter.statuses.length > 0) {
    const wanted = new Set<JobStatus>(filter.statuses);
    result = result.filter((job) => wanted.has(job.status));
  }
  if (filter.tools && filter.tools.length > 0) {
    const wanted = new Set<string>(filter.tools);
    result = result.filter((job) => wanted.has(job.tool));
  }
  if (filter.projects && filter.projects.length > 0) {
    const wanted = new Set<string>(filter.projects);
    result = result.filter((job) => wanted.has(job.project));
  }

  const query = filter.search?.trim().toLowerCase();
  if (query) {
    result = result.filter((job) => {
      const haystack = `${job.project} ${job.id} ${job.command.join(" ")}`.toLowerCase();
      return haystack.includes(query);
    });
  }

  return result;
}

/**
 * The distinct project names present in a job list, sorted alphabetically —
 * used to populate the project filter dropdown from whatever is on screen.
 */
export function distinctProjects(jobs: RelayJob[]): string[] {
  return Array.from(new Set(jobs.map((job) => job.project))).sort((a, b) => a.localeCompare(b));
}

/** The distinct tool names present in a job list, sorted alphabetically. */
export function distinctTools(jobs: RelayJob[]): string[] {
  return Array.from(new Set(jobs.map((job) => job.tool))).sort((a, b) => a.localeCompare(b));
}
