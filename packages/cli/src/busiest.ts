// Rendering for `agentrelay busiest` — a per-command index of the queue built
// from `job.command`, ranked by the total resume attempts each command has
// accrued ("relay effort"). Where `projects`/`tools` group by label and agent
// tool, `busiest` answers "which exact command is the relay working hardest
// on?" — the command that keeps hitting limits and keeps getting babysat.
// Pure functions, kept separate from the commander wiring in cli.ts so the
// output is unit-testable without a store or a clock (the only ambient input,
// `now`, is injectable for the reset countdown).

import type { BusiestSummary } from "@agentrelay/core";
import { formatCountdown } from "./status.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Shown when the store (or scoped subset) has no jobs at all. */
export const NO_COMMANDS_MESSAGE = "No jobs yet. Run `agentrelay run -- <your agent command>` to get started.";

/** Shown when a `--status`/`--tool`/`--project` scope matches nothing. */
export const NO_SCOPE_MATCH_MESSAGE = "No jobs match the current filter.";

/** Default number of rows the human table shows before truncating. */
export const DEFAULT_LIMIT = 20;

/**
 * Renders the command index as a table: one row per distinct command with its
 * job count, active count, total resume attempts, and — when jobs are parked —
 * the soonest reset (with a live countdown). Rows arrive pre-ranked from
 * `summarizeBusiest` (costliest first); `limit` (default {@link DEFAULT_LIMIT})
 * caps how many are printed, with a trailing "…and N more" note when truncated.
 * Pure: no I/O; the only ambient input is `now`, used solely for the countdown.
 * `color` gates ANSI codes (TTY only); a `scopeNote` is echoed once at the top.
 */
export function renderBusiest(
  summary: BusiestSummary,
  options: { color?: boolean; scopeNote?: string; now?: number; limit?: number } = {}
): string {
  const color = options.color ?? false;
  const now = options.now ?? Date.now();
  const limit = options.limit ?? DEFAULT_LIMIT;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [];
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));

  if (summary.total === 0) {
    lines.push(options.scopeNote ? NO_SCOPE_MATCH_MESSAGE : NO_COMMANDS_MESSAGE);
    return lines.join("\n");
  }

  const cmdWord = summary.commandCount === 1 ? "command" : "commands";
  const jobWord = summary.total === 1 ? "job" : "jobs";
  const attemptWord = summary.totalAttempts === 1 ? "resume attempt" : "resume attempts";
  lines.push(
    b(`${summary.commandCount} ${cmdWord}`) +
      d(` across ${summary.total} ${jobWord} · ${summary.totalAttempts} ${attemptWord}`)
  );
  lines.push("");

  const shown = limit > 0 ? summary.commands.slice(0, limit) : summary.commands;
  const nameWidth = Math.min(40, Math.max(7, ...shown.map((c) => c.display.length)));
  lines.push(
    d(
      `  ${"COMMAND".padEnd(nameWidth)}  ${"JOBS".padStart(4)}  ${"ACTIVE".padStart(6)}  ${"RESUMES".padStart(
        7
      )}  NEXT RESET`
    )
  );

  for (const c of shown) {
    const name = c.display.length > nameWidth ? `${c.display.slice(0, nameWidth - 1)}…` : c.display.padEnd(nameWidth);
    const jobs = String(c.total).padStart(4);
    const active = String(c.active).padStart(6);
    const resumes = String(c.attempts).padStart(7);
    let reset: string;
    if (c.nextResetAt) {
      reset = `${c.nextResetAt} ${d(`(in ${formatCountdown(c.nextResetAt, now)})`)}`;
    } else if (c.active > 0) {
      reset = d("—");
    } else {
      reset = d("(idle)");
    }
    lines.push(`  ${name}  ${jobs}  ${active}  ${resumes}  ${reset}`);
  }

  const hidden = summary.commands.length - shown.length;
  if (hidden > 0) lines.push(d(`  …and ${hidden} more (raise --limit or use --json to see all)`));

  return lines.join("\n");
}

/**
 * Machine-readable form of `agentrelay busiest`, mirroring the
 * `renderProjectsJson` / `renderToolsJson` envelope: the resolved store path,
 * when it was generated, the optional active scope, and the full summary (all
 * commands, unaffected by the human table's `--limit`). Pure: `generatedAt` is
 * injected, never read from an ambient clock here.
 */
export function renderBusiestJson(payload: {
  storePath: string;
  generatedAt: string;
  scope?: Record<string, unknown>;
  summary: BusiestSummary;
}): string {
  return JSON.stringify(payload, null, 2);
}
