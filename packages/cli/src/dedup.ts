// Rendering for `agentrelay dedup` — a read-only diagnostic that surfaces
// duplicate *active* work: clusters of queued/waiting jobs that share a tool,
// working directory, and command and would therefore resume the exact same
// thing more than once. Where `overdue` answers "what should be running but
// isn't?", `dedup` answers "what is queued to run twice?". Kept as pure
// functions (separate from the commander wiring in cli.ts) so the output is
// unit-testable without a store or a clock; the only ambient input, `now`, is
// injectable for the reset countdown.

import type { DedupReport } from "@agentrelay/core";
import { formatCommand } from "./show.js";
import { formatCountdown } from "./status.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/** Shown when the store (or scoped subset) has no jobs at all. */
export const NO_JOBS_MESSAGE = "No jobs yet. Run `agentrelay run -- <your agent command>` to get started.";

/** Shown when a `--status`/`--tool`/`--project` scope matches nothing. */
export const NO_SCOPE_MATCH_MESSAGE = "No jobs match the current filter.";

/** Shown when there are jobs but no duplicate active work — the healthy case. */
export const NO_DUPLICATES_MESSAGE = "No duplicate active jobs — every pending resume runs a distinct command.";

/**
 * Renders the duplicate report as a ranked list of clusters. Each cluster shows
 * the shared tool + command + cwd, how many clones exist (and how many are
 * redundant), the soonest reset (with a live countdown), and the short ids of
 * every job so the reader can `agentrelay cancel <id>` the extras. Pure: no I/O;
 * the only ambient input is `now`, used solely for the countdown and defaulted
 * when omitted. `color` gates ANSI codes (TTY only); `scopeNote` is echoed once
 * at the top when a filter is active; `limit` trims the shown clusters (totals
 * still count them all). `hasJobs` distinguishes an empty store from a store
 * that simply has no duplicates.
 */
export function renderDedup(
  report: DedupReport,
  options: { color?: boolean; scopeNote?: string; now?: number; limit?: number; hasJobs?: boolean } = {}
): string {
  const color = options.color ?? false;
  const now = options.now ?? Date.now();
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const g = (s: string): string => (color ? `${GREEN}${s}${RESET}` : s);
  const y = (s: string): string => (color ? `${YELLOW}${s}${RESET}` : s);

  const lines: string[] = [];
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));

  if (report.groupCount === 0) {
    if (options.hasJobs === false) {
      lines.push(options.scopeNote ? NO_SCOPE_MATCH_MESSAGE : NO_JOBS_MESSAGE);
    } else {
      lines.push(g(NO_DUPLICATES_MESSAGE));
    }
    return lines.join("\n");
  }

  const clusterWord = report.groupCount === 1 ? "cluster" : "clusters";
  lines.push(
    `${b(`${report.groupCount} duplicate ${clusterWord}`)}` +
      d(` · ${report.duplicateJobs} job(s), `) +
      y(`${report.redundantJobs} redundant resume(s)`)
  );

  const shown =
    typeof options.limit === "number" && options.limit >= 0 ? report.groups.slice(0, options.limit) : report.groups;

  for (const [i, group] of shown.entries()) {
    lines.push("");
    const header =
      `${b(`${i + 1}.`)} ${group.count}× ` +
      d(`(${group.redundant} redundant)`) +
      `  ${group.tool}  ${d(group.project)}`;
    lines.push(header);
    lines.push(`   ${formatCommand(group.command)}`);
    lines.push(d(`   cwd: ${group.cwd}`));
    if (group.nextResetAt) {
      lines.push(d(`   next reset: ${group.nextResetAt} (in ${formatCountdown(group.nextResetAt, now)})`));
    }
    const ids = group.jobs.map((job, idx) => (idx === 0 ? `${job.id.slice(0, 8)} ${d("(keep)")}` : job.id.slice(0, 8)));
    lines.push(d(`   jobs: `) + ids.join(d(", ")));
  }

  const hidden = report.groupCount - shown.length;
  if (hidden > 0) {
    lines.push("");
    lines.push(d(`… ${hidden} more cluster(s) not shown (raise --limit to see them).`));
  }

  return lines.join("\n");
}

/**
 * Machine-readable form of `agentrelay dedup`, mirroring the
 * `renderToolsJson` / `renderStatsJson` envelope: the resolved store path, when
 * it was generated, the optional active scope, and the full report. Pure:
 * `generatedAt` is injected, never read from an ambient clock here.
 */
export function renderDedupJson(payload: {
  storePath: string;
  generatedAt: string;
  scope?: Record<string, unknown>;
  report: DedupReport;
}): string {
  return JSON.stringify(payload, null, 2);
}
