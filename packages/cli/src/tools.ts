// Rendering helpers for `agentrelay tools` — a per-tool index of the queue built
// from `job.tool` (the agent CLI a job runs), the label the whole `--tool`
// filter ecosystem keys off. The mirror image of `renderProjects`. Kept as pure
// functions here, separate from the commander wiring in cli.ts, so the exact
// output is unit-testable without a store or a clock (the only ambient input,
// `now`, is injectable for the reset countdown).

import type { ToolsSummary } from "@agentrelay/core";
import { formatCountdown } from "./status.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Shown when the store (or scoped subset) has no jobs at all. */
export const NO_TOOLS_MESSAGE = "No jobs yet. Run `agentrelay run -- <your agent command>` to get started.";

/** Shown when a `--status`/`--tool`/`--project` scope matches nothing. */
export const NO_SCOPE_MATCH_MESSAGE = "No jobs match the current filter.";

/**
 * Renders the tool index as a table: one row per agent tool with its total,
 * active, and terminal counts plus, when jobs are parked, the soonest reset
 * (with a live countdown). Pure: no I/O; the only ambient input is `now`, used
 * solely for the countdown and defaulted when omitted. `color` gates ANSI codes
 * (TTY only); a `scopeNote` is echoed once at the top when a filter is active.
 */
export function renderTools(
  summary: ToolsSummary,
  options: { color?: boolean; scopeNote?: string; now?: number } = {}
): string {
  const color = options.color ?? false;
  const now = options.now ?? Date.now();
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  const lines: string[] = [];
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));

  if (summary.total === 0) {
    lines.push(options.scopeNote ? NO_SCOPE_MATCH_MESSAGE : NO_TOOLS_MESSAGE);
    return lines.join("\n");
  }

  lines.push(b(`${summary.toolCount} tool(s)`) + d(` across ${summary.total} job(s)`));
  lines.push("");

  const nameWidth = Math.min(20, Math.max(7, ...summary.tools.map((t) => t.tool.length)));
  lines.push(
    d(
      `  ${"TOOL".padEnd(nameWidth)}  ${"TOTAL".padStart(5)}  ${"ACTIVE".padStart(6)}  ${"DONE".padStart(4)}  NEXT RESET`
    )
  );

  for (const t of summary.tools) {
    const name = t.tool.length > nameWidth ? `${t.tool.slice(0, nameWidth - 1)}…` : t.tool.padEnd(nameWidth);
    const total = String(t.total).padStart(5);
    const active = String(t.active).padStart(6);
    const done = String(t.terminal).padStart(4);
    let reset: string;
    if (t.nextResetAt) {
      reset = `${t.nextResetAt} ${d(`(in ${formatCountdown(t.nextResetAt, now)})`)}`;
    } else if (t.active > 0) {
      reset = d("—");
    } else {
      reset = d("(idle)");
    }
    lines.push(`  ${name}  ${total}  ${active}  ${done}  ${reset}`);
  }

  return lines.join("\n");
}

/**
 * One frame of the live `agentrelay tools --watch` view: a title/header block
 * (matching the shape of `status`/`upcoming`/`overdue --watch`) plus the colored
 * tool index. Separated out so the watch loop only has to clear the screen and
 * print this. The reset countdowns tick down in place because the loop re-reads
 * the store and re-summarizes with a fresh `now` each pass. Pure: `now` is
 * injectable so the frame is unit-testable without a TTY or a clock.
 */
export function renderToolsWatchFrame(
  summary: ToolsSummary,
  storePath: string,
  intervalMs: number,
  now: number = Date.now(),
  scopeNote?: string
): string {
  const stamp = new Date(now).toISOString().replace("T", " ").slice(0, 19);
  const title = `${BOLD}agentrelay tools${RESET} ${DIM}(live, every ${Math.round(
    intervalMs / 1000
  )}s — Ctrl-C to exit)${RESET}`;
  const meta = `${DIM}${stamp}Z · ${storePath}${RESET}`;
  return [title, meta, "", renderTools(summary, { color: true, scopeNote, now })].join("\n");
}

/**
 * Machine-readable form of `agentrelay tools`, mirroring the `renderProjectsJson`
 * / `renderStatsJson` envelope: the resolved store path, when it was generated,
 * the optional active scope, and the full summary. Pure: `generatedAt` is
 * injected, never read from an ambient clock here.
 */
export function renderToolsJson(payload: {
  storePath: string;
  generatedAt: string;
  scope?: Record<string, unknown>;
  summary: ToolsSummary;
}): string {
  return JSON.stringify(payload, null, 2);
}
