// Rendering helpers for `agentrelay errors` — a ranked breakdown of why jobs
// failed, grouped by a normalized signature of each job's lastError. Kept as
// pure functions here, separate from the commander wiring in cli.ts, so the
// exact output is unit-testable without a store.

import type { ErrorBreakdown, ErrorGroup, GroupDimension, GroupedErrorBreakdown } from "@agentrelay/core";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

export const NO_ERRORS_MESSAGE = "No jobs have recorded an error. Nothing to break down.";

/** Shown when a scope filter matches jobs but none of them carry an error. */
export const NO_ERROR_MATCH_MESSAGE = "No matching jobs have recorded an error.";

/**
 * Render one error group as a block: a ranked header line (count + short id
 * sample), the signature, and a dim tail of extra job ids when there are more
 * than a couple. Pure.
 */
function renderGroup(group: ErrorGroup, index: number, color: boolean): string {
  const bold = color ? BOLD : "";
  const dim = color ? DIM : "";
  const red = color ? RED : "";
  const reset = color ? RESET : "";

  const times = group.count === 1 ? "1 job" : `${group.count} jobs`;
  const statuses = group.statuses.join(", ");
  const header = `${bold}${index + 1}. ${red}${times}${reset}${dim} (${statuses})${reset}`;
  const signatureLine = `   ${group.signature}`;

  // Show a handful of ids so `agentrelay show <id>` is one copy-paste away,
  // eliding the rest to keep the block compact for large groups.
  const shortIds = group.jobIds.slice(0, 3).map((id) => id.slice(0, 8));
  const more = group.jobIds.length - shortIds.length;
  const idsText = more > 0 ? `${shortIds.join(" ")} +${more} more` : shortIds.join(" ");
  const idsLine = `   ${dim}ids: ${idsText}${reset}`;

  return [header, signatureLine, idsLine].join("\n");
}

/**
 * Renders the full error breakdown as a multi-line block. Pure: no I/O. `color`
 * gates ANSI codes (TTY only). `limit` shows at most N groups and appends a
 * "M more not shown" footer; the total counts always reflect every group.
 * `scopeNote`, when set, prints a "scope: …" line and switches the empty
 * message from "no errors yet" to "no matching jobs have errors".
 */
export function renderErrorBreakdown(
  breakdown: ErrorBreakdown,
  options: { color?: boolean; limit?: number; scopeNote?: string } = {}
): string {
  const color = options.color ?? false;
  const bold = color ? BOLD : "";
  const dim = color ? DIM : "";
  const reset = color ? RESET : "";

  const lines: string[] = [];
  lines.push(`${bold}Error breakdown${reset}`);
  if (options.scopeNote) lines.push(`${dim}scope: ${options.scopeNote}${reset}`);

  if (breakdown.groups.length === 0) {
    lines.push("");
    lines.push(options.scopeNote ? NO_ERROR_MATCH_MESSAGE : NO_ERRORS_MESSAGE);
    return lines.join("\n");
  }

  lines.push(
    `${dim}${breakdown.totalWithErrors} job(s) with errors across ` +
      `${breakdown.distinctSignatures} distinct reason(s)${reset}`
  );
  lines.push("");

  const limit = options.limit;
  const shown = limit !== undefined ? breakdown.groups.slice(0, limit) : breakdown.groups;
  lines.push(shown.map((group, i) => renderGroup(group, i, color)).join("\n\n"));

  const hidden = breakdown.groups.length - shown.length;
  if (hidden > 0) {
    lines.push("");
    lines.push(`${dim}… ${hidden} more reason(s) not shown (raise --limit)${reset}`);
  }

  return lines.join("\n");
}

/** Shown when `--group-by` is used but no group produced any error. */
export const NO_GROUPED_ERRORS_MESSAGE = "No jobs have recorded an error. Nothing to break down.";

/** Same, but for a scope that matched jobs yet none carried an error. */
export const NO_GROUPED_ERROR_MATCH_MESSAGE = "No matching jobs have recorded an error.";

/**
 * Renders a per-dimension error breakdown (`agentrelay errors --group-by`). Each
 * group prints a header with its key and error count, then the same ranked
 * reason blocks as the ungrouped view, indented under it. Pure: no I/O. `limit`
 * caps the reasons shown *within each group*; the group's count always reflects
 * all of its errors. `scopeNote`, when set, prints a "scope: …" line and switches
 * the empty message to the "no matching jobs" variant.
 */
export function renderGroupedErrorBreakdown(
  groups: GroupedErrorBreakdown[],
  dimension: GroupDimension,
  options: { color?: boolean; limit?: number; scopeNote?: string } = {}
): string {
  const color = options.color ?? false;
  const bold = color ? BOLD : "";
  const dim = color ? DIM : "";
  const red = color ? RED : "";
  const reset = color ? RESET : "";

  const lines: string[] = [];
  lines.push(`${bold}Error breakdown by ${dimension}${reset}`);
  if (options.scopeNote) lines.push(`${dim}scope: ${options.scopeNote}${reset}`);

  if (groups.length === 0) {
    lines.push("");
    lines.push(options.scopeNote ? NO_GROUPED_ERROR_MATCH_MESSAGE : NO_GROUPED_ERRORS_MESSAGE);
    return lines.join("\n");
  }

  const totalErrors = groups.reduce((sum, g) => sum + g.count, 0);
  lines.push(`${dim}${totalErrors} job(s) with errors across ${groups.length} ${dimension}(s)${reset}`);

  for (const group of groups) {
    lines.push("");
    const times = group.count === 1 ? "1 error" : `${group.count} errors`;
    lines.push(
      `${bold}${red}${group.key}${reset}${dim} — ${times}, ${group.breakdown.distinctSignatures} reason(s)${reset}`
    );

    const limit = options.limit;
    const shown = limit !== undefined ? group.breakdown.groups.slice(0, limit) : group.breakdown.groups;
    for (const [i, reason] of shown.entries()) {
      const label = reason.count === 1 ? "1 job" : `${reason.count} jobs`;
      lines.push(`  ${bold}${i + 1}. ${red}${label}${reset}${dim} (${reason.statuses.join(", ")})${reset}`);
      lines.push(`     ${reason.signature}`);
    }
    const hidden = group.breakdown.groups.length - shown.length;
    if (hidden > 0) lines.push(`  ${dim}… ${hidden} more reason(s) not shown (raise --limit)${reset}`);
  }

  return lines.join("\n");
}

/** Machine-readable form of the grouped error breakdown for scripts/jq. */
export function renderGroupedErrorBreakdownJson(
  groups: GroupedErrorBreakdown[],
  dimension: GroupDimension,
  store: string,
  options: { scopeNote?: string } = {}
): string {
  return JSON.stringify(
    {
      store,
      scope: options.scopeNote ?? null,
      groupBy: dimension,
      groups,
    },
    null,
    2
  );
}

/**
 * Machine-readable form of the error breakdown for scripts/jq. Includes the
 * store path and echoes an active scope note (if any). Pretty-printed with a
 * trailing newline stripped by the caller's console.log.
 */
export function renderErrorBreakdownJson(
  breakdown: ErrorBreakdown,
  store: string,
  options: { scopeNote?: string } = {}
): string {
  return JSON.stringify(
    {
      store,
      scope: options.scopeNote ?? null,
      totalWithErrors: breakdown.totalWithErrors,
      distinctSignatures: breakdown.distinctSignatures,
      groups: breakdown.groups,
    },
    null,
    2
  );
}
