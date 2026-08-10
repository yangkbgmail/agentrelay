import type { JobSearchField, RelayJob } from "@agentrelay/core";
import { type RenderOptions, renderStatusJson, renderStatusTable } from "./status.js";

/** Dim ANSI for the query preface line (matches status.ts conventions). */
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export interface SearchRenderContext {
  /** The raw query text, echoed in the preface. */
  query: string;
  /** Fields that were searched (already resolved to the effective set). */
  fields: JobSearchField[];
  /** Whether the query was interpreted as a regex. */
  regex: boolean;
  /** Whether the match was case-sensitive. */
  caseSensitive: boolean;
  /** Active scope note (from the shared --status/--tool/... filters), if any. */
  scopeNote?: string;
}

/** Message shown when a search matches no jobs (distinct from an empty store). */
export const NO_SEARCH_MATCH_MESSAGE = "No jobs match that search.";

/**
 * One-line description of what was searched, e.g.
 * `Search "migrate" in command,project (regex, case-insensitive) — 2 match(es)`.
 * Kept plain-text-safe; color is applied by the caller via {@link renderSearch}.
 */
export function searchHeaderLine(matched: number, ctx: SearchRenderContext): string {
  const mode = [ctx.regex ? "regex" : "literal", ctx.caseSensitive ? "case-sensitive" : "case-insensitive"].join(", ");
  const scope = ctx.scopeNote ? ` [scope: ${ctx.scopeNote}]` : "";
  return `Search "${ctx.query}" in ${ctx.fields.join(",")} (${mode})${scope} — ${matched} match(es)`;
}

/**
 * Renders search results: a query-describing preface line, then the standard
 * status table for the matches (so output stays consistent with `status`).
 * Reuses `renderStatusTable`, which already prints the summary footer and any
 * `--limit` truncation note.
 */
export function renderSearch(jobs: RelayJob[], ctx: SearchRenderContext, options: RenderOptions = {}): string {
  const color = options.color ?? false;
  const header = searchHeaderLine(jobs.length, ctx);
  const headerLine = color ? `${DIM}${header}${RESET}` : header;
  if (jobs.length === 0) {
    return [headerLine, NO_SEARCH_MATCH_MESSAGE].join("\n");
  }
  return [headerLine, renderStatusTable(jobs, options)].join("\n");
}

/**
 * Machine-readable JSON for `--json`. Reuses the status snapshot shape (so
 * scripts already consuming `status --json` work unchanged) and attaches the
 * search parameters under a `search` field for provenance.
 */
export function renderSearchJson(
  jobs: RelayJob[],
  storePath: string,
  ctx: SearchRenderContext,
  generatedAt: string = new Date().toISOString(),
  limit?: number
): string {
  const base = JSON.parse(renderStatusJson(jobs, storePath, generatedAt, limit));
  base.search = {
    query: ctx.query,
    fields: ctx.fields,
    regex: ctx.regex,
    caseSensitive: ctx.caseSensitive,
    ...(ctx.scopeNote ? { scope: ctx.scopeNote } : {}),
  };
  return JSON.stringify(base, null, 2);
}
