// Rendering for `agentrelay dedupe` — collapse redundant queued jobs.
//
// Re-running the same rate-limited command mints a second identical job, so the
// scheduler would resume the exact same process twice when the window reopens.
// `dedupe` finds those collisions (same tool + cwd + command argv), keeps the
// one that resumes soonest, and cancels the rest. These are pure renderers over
// the core `DedupePlan`, kept out of the commander wiring so the output is
// testable without a TTY or a store.

import type { DedupePlan, DuplicateGroup, RelayJob } from "@agentrelay/core";
import { formatCommand } from "./show.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Shown when no identical active jobs were found — the queue has no redundancy. */
export const NO_DUPLICATES_MESSAGE = "No duplicate jobs — every queued command is unique.";

function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * Human-friendly report of the de-duplication plan: one block per collision,
 * showing the shared command, the kept job, and the duplicate(s) that were (or,
 * in a dry run, would be) cancelled. `dryRun` only changes the verbs and footer;
 * `cancelledCount` lets the caller report how many were actually removed (it
 * matches `plan.duplicateCount` unless some cancels were skipped).
 */
export function renderDedupePlan(
  plan: DedupePlan,
  options: { color?: boolean; dryRun?: boolean; scopeNote?: string; cancelledCount?: number } = {}
): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const scope = options.scopeNote ? ` ${d(`[scope: ${options.scopeNote}]`)}` : "";

  if (plan.groups.length === 0) {
    return NO_DUPLICATES_MESSAGE + scope;
  }

  const lines: string[] = [];
  for (const group of plan.groups) {
    lines.push(b(formatCommand(group.command)));
    lines.push(d(`  in ${group.cwd}  (${group.tool})`));
    lines.push(`  keep ${shortId(group.keep.id)}  ${d(keeperNote(group.keep))}`);
    for (const dup of group.duplicates) {
      const mark = options.dryRun ? "-" : "×";
      lines.push(`  ${mark} ${shortId(dup.id)}  ${d(dupNote(dup))}`);
    }
    lines.push("");
  }

  const cancelled = options.cancelledCount ?? plan.duplicateCount;
  const footer = options.dryRun
    ? `Would cancel ${plan.duplicateCount} duplicate job(s) across ${plan.groups.length} command(s) — no changes made.`
    : `Cancelled ${cancelled} duplicate job(s) across ${plan.groups.length} command(s).`;
  lines.push(footer + scope);
  return lines.join("\n");
}

/** A one-line annotation for the kept job (its status / reset time). */
function keeperNote(job: RelayJob): string {
  return job.resetAt ? `${job.status}, resumes at ${job.resetAt}` : job.status;
}

/** A one-line annotation for a duplicate being cancelled. */
function dupNote(job: RelayJob): string {
  return job.resetAt ? `${job.status}, was set for ${job.resetAt}` : job.status;
}

/**
 * Machine-readable form of the plan for `--json`: the store path, whether this
 * was a dry run, per-group keep/duplicate ids, and the totals. Ids are full
 * (never truncated) so scripts can act on them.
 */
export function renderDedupePlanJson(
  plan: DedupePlan,
  options: { storePath: string; dryRun: boolean; cancelledIds?: string[] }
): string {
  return JSON.stringify(
    {
      storePath: options.storePath,
      dryRun: options.dryRun,
      duplicateCount: plan.duplicateCount,
      scannedCount: plan.scannedCount,
      cancelledIds: options.cancelledIds ?? [],
      groups: plan.groups.map((group: DuplicateGroup) => ({
        tool: group.tool,
        cwd: group.cwd,
        command: group.command,
        keep: group.keep.id,
        duplicates: group.duplicates.map((j) => j.id),
      })),
    },
    null,
    2
  );
}
