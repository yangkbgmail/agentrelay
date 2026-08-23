// Free-text search across the job store. `agentrelay status` and `stats` can
// already filter by structured dimensions (status / tool / project / time
// window), but none of them can answer "which job was that refactor I kicked
// off last week?" once a queue grows past a screenful — the only text that
// identifies a job to a human lives in its `command`, its `project`, or (when
// it failed) its `lastError`, and there was no way to grep those. This module
// is that grep: a pure, clock-free, filesystem-free substring/regex matcher so
// the exact behaviour is unit-testable without a store on disk.

import type { RelayJob } from "./types.js";

/** Job fields `agentrelay search` can look inside. */
export const SEARCH_FIELDS = ["command", "project", "id", "error", "tool"] as const;
export type SearchField = (typeof SEARCH_FIELDS)[number];

/**
 * Fields searched when the caller doesn't restrict with `--field`. These are
 * the ones that carry human-meaningful, free-form text: the command that was
 * rate-limited, the project label, the (usually random) id, and the last error
 * when a job failed. `tool` is a small closed vocabulary better served by
 * `status --tool`, so it's opt-in rather than part of the default sweep.
 */
export const DEFAULT_SEARCH_FIELDS: readonly SearchField[] = ["command", "project", "id", "error"];

/** True when `value` is one of the known searchable field names. */
export function isSearchField(value: string): value is SearchField {
  return (SEARCH_FIELDS as readonly string[]).includes(value);
}

export interface SearchOptions {
  /** Which fields to search (defaults to {@link DEFAULT_SEARCH_FIELDS}). */
  fields?: readonly SearchField[];
  /** Treat the query as a JavaScript regular expression instead of a substring. */
  regex?: boolean;
  /** Match case-sensitively (default: case-insensitive). */
  caseSensitive?: boolean;
}

/** A compiled query that can be tested against arbitrary text. */
export interface CompiledSearch {
  test(text: string): boolean;
}

/**
 * Compiles a query once so it isn't re-parsed per job. In regex mode an invalid
 * pattern throws `SyntaxError` (the CLI catches it and exits non-zero); in
 * substring mode compilation never fails.
 */
export function compileSearch(query: string, options: SearchOptions = {}): CompiledSearch {
  if (options.regex) {
    const re = new RegExp(query, options.caseSensitive ? "" : "i");
    return { test: (text) => re.test(text) };
  }
  if (options.caseSensitive) {
    return { test: (text) => text.includes(query) };
  }
  const needle = query.toLowerCase();
  return { test: (text) => text.toLowerCase().includes(needle) };
}

/** The searchable text of one field of a job (arrays joined, nulls → ""). */
export function jobFieldText(job: RelayJob, field: SearchField): string {
  switch (field) {
    case "command":
      return job.command.join(" ");
    case "project":
      return job.project;
    case "id":
      return job.id;
    case "error":
      return job.lastError ?? "";
    case "tool":
      return job.tool;
  }
}

/** Drop unknown/duplicate fields; fall back to the default set when empty. */
function normalizeFields(fields: readonly SearchField[] | undefined): readonly SearchField[] {
  if (!fields || fields.length === 0) return DEFAULT_SEARCH_FIELDS;
  const seen = new Set<SearchField>();
  const out: SearchField[] = [];
  for (const field of fields) {
    if (isSearchField(field) && !seen.has(field)) {
      seen.add(field);
      out.push(field);
    }
  }
  return out.length > 0 ? out : DEFAULT_SEARCH_FIELDS;
}

/** The subset of the searched fields whose text matched (for provenance). */
export function matchedFields(job: RelayJob, matcher: CompiledSearch, options: SearchOptions = {}): SearchField[] {
  const fields = normalizeFields(options.fields);
  return fields.filter((field) => matcher.test(jobFieldText(job, field)));
}

/**
 * Returns the jobs whose text matches `query`, preserving input order. Pure and
 * non-mutating (always a fresh array). An empty query matches nothing (rather
 * than everything, which would be a footgun); the CLI rejects it earlier with a
 * clearer message. A job matches when ANY of the searched fields matches.
 */
export function searchJobs(jobs: RelayJob[], query: string, options: SearchOptions = {}): RelayJob[] {
  if (query === "") return [];
  const fields = normalizeFields(options.fields);
  const matcher = compileSearch(query, options);
  return jobs.filter((job) => fields.some((field) => matcher.test(jobFieldText(job, field))));
}
