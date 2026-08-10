import type { RelayJob } from "./types.js";

/**
 * Which text of a job a free-text search looks at. The whole filter ecosystem
 * (`status`/`stats`/`export`/…) already scopes by *structured* dimensions
 * (status, tool, project, time window) — but none of them can answer "which job
 * ran the command mentioning `migrate-db`?" or "which failure mentioned
 * ENOSPC?". These fields cover the free-text surfaces a human actually recalls a
 * job by.
 */
export type JobSearchField = "command" | "project" | "id" | "error";

/** Every field {@link searchJobs} can look at, for CLI validation/help text. */
export const JOB_SEARCH_FIELDS: JobSearchField[] = ["command", "project", "id", "error"];

/** Type guard for a raw `--field` token coming off the CLI. */
export function isJobSearchField(value: string): value is JobSearchField {
  return (JOB_SEARCH_FIELDS as string[]).includes(value);
}

export interface JobSearchQuery {
  /** The text (or regex source, when `regex` is set) to look for. */
  query: string;
  /**
   * Restrict the search to these fields. Empty/undefined means "all fields"
   * ({@link JOB_SEARCH_FIELDS}), so a bare `agentrelay search foo` finds `foo`
   * anywhere it's recorded.
   */
  fields?: JobSearchField[];
  /** Treat `query` as a JavaScript regular expression instead of a literal substring. */
  regex?: boolean;
  /** Match case-sensitively. Defaults to false (case-insensitive). */
  caseSensitive?: boolean;
}

/**
 * The searchable text of a single job for one field. `command` is joined with
 * spaces (the same shape `show` echoes), so a query can match across argv
 * boundaries. `error` collapses `null` to the empty string so an absent error
 * simply never matches rather than throwing.
 */
export function jobFieldText(job: RelayJob, field: JobSearchField): string {
  switch (field) {
    case "command":
      return job.command.join(" ");
    case "project":
      return job.project;
    case "id":
      return job.id;
    case "error":
      return job.lastError ?? "";
  }
}

/** A compiled predicate that answers "does this job match?". */
export type JobMatcher = (job: RelayJob) => boolean;

/**
 * Compile a {@link JobSearchQuery} into a reusable {@link JobMatcher}. Pure and
 * non-throwing: an empty query or a malformed regex comes back as `{ error }`
 * (mirroring `buildScope`) so the CLI can report it and exit 1 rather than
 * crashing. Case-insensitivity is handled by the regex `i` flag in regex mode,
 * and by lower-casing both needle and haystack in literal mode.
 */
export function compileJobMatcher(query: JobSearchQuery): { matcher: JobMatcher } | { error: string } {
  const raw = query.query;
  if (raw.length === 0) return { error: "Search query must not be empty." };

  const fields = query.fields && query.fields.length > 0 ? query.fields : JOB_SEARCH_FIELDS;

  let test: (text: string) => boolean;
  if (query.regex) {
    let re: RegExp;
    try {
      re = new RegExp(raw, query.caseSensitive ? "" : "i");
    } catch (err) {
      return { error: `Invalid regular expression: ${(err as Error).message}` };
    }
    test = (text) => re.test(text);
  } else if (query.caseSensitive) {
    test = (text) => text.includes(raw);
  } else {
    const needle = raw.toLowerCase();
    test = (text) => text.toLowerCase().includes(needle);
  }

  const matcher: JobMatcher = (job) => fields.some((field) => test(jobFieldText(job, field)));
  return { matcher };
}

/**
 * Narrow a job list to those matching a free-text {@link JobSearchQuery},
 * preserving input order (so callers keep the store's newest-first ordering).
 * Returns `{ error }` for an empty query or bad regex — never throws, never
 * mutates the input. Composes with `scopeJobs`: filter by structured scope
 * first, then search the remainder.
 */
export function searchJobs(jobs: RelayJob[], query: JobSearchQuery): { jobs: RelayJob[] } | { error: string } {
  const compiled = compileJobMatcher(query);
  if ("error" in compiled) return compiled;
  return { jobs: jobs.filter(compiled.matcher) };
}
