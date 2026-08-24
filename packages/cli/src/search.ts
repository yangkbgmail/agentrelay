// Rendering helpers for `agentrelay search <query>`. Kept as pure functions
// (separate from the commander wiring in cli.ts) so the exact output — the
// match headline, the table, and the `--json` shape — is unit-testable without
// a store on disk or a TTY. The result table itself reuses the `status`
// renderer so search and status stay visually identical.

import type { RelayJob, SearchField } from "@agentrelay/core";
import { renderStatusTable } from "./status.js";

/** Shown when a search matches no jobs. */
export const NO_SEARCH_MATCH_MESSAGE = "No jobs match your search.";

export interface SearchHeadlineInput {
  query: string;
  /** Number of jobs that matched. */
  matched: number;
  /** Size of the store that was searched. */
  total: number;
  /** Fields that were searched (for the "(in …)" note). */
  fields: readonly SearchField[];
  /** Whether the query was a regular expression. */
  regex?: boolean;
}

/**
 * The one-line summary printed above the results table, e.g.
 * `2 of 40 job(s) match /auth/ (in command, project)`. Substring queries are
 * shown in double quotes, regex queries in slashes, so the two modes read
 * differently at a glance.
 */
export function searchHeadline(input: SearchHeadlineInput): string {
  const needle = input.regex ? `/${input.query}/` : `"${input.query}"`;
  const where = input.fields.length > 0 ? ` (in ${input.fields.join(", ")})` : "";
  return `${input.matched} of ${input.total} job(s) match ${needle}${where}`;
}

export interface RenderSearchOptions {
  now?: number;
  color?: boolean;
  limit?: number;
  regex?: boolean;
  fields: readonly SearchField[];
  total: number;
}

/**
 * Full human-readable search output: the headline plus a status-style table of
 * the matches (or a "no match" line). `matches` is expected to already be the
 * filtered set; `total` is the pre-search store size for the "N of M" headline.
 */
export function renderSearch(matches: RelayJob[], query: string, options: RenderSearchOptions): string {
  const headline = searchHeadline({
    query,
    matched: matches.length,
    total: options.total,
    fields: options.fields,
    regex: options.regex,
  });
  if (matches.length === 0) {
    return `${headline}\n${NO_SEARCH_MATCH_MESSAGE}`;
  }
  const table = renderStatusTable(matches, { now: options.now, color: options.color, limit: options.limit });
  return `${headline}\n\n${table}`;
}

/** Machine-readable search result for `--json` (scripts, jq, other tooling). */
export function renderSearchJson(
  matches: RelayJob[],
  query: string,
  options: { total: number; fields: readonly SearchField[]; regex?: boolean; storePath?: string; limit?: number }
): string {
  const truncated =
    typeof options.limit === "number" &&
    Number.isFinite(options.limit) &&
    options.limit > 0 &&
    matches.length > options.limit;
  const emitted = truncated ? matches.slice(0, options.limit) : matches;
  return JSON.stringify(
    {
      query,
      regex: Boolean(options.regex),
      fields: options.fields,
      storePath: options.storePath,
      total: options.total,
      matched: matches.length,
      returned: emitted.length,
      jobs: emitted,
    },
    null,
    2
  );
}
