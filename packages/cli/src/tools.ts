// Rendering helpers for `agentrelay tools` — the tool-axis twin of
// `agentrelay projects`. Where `projects` indexes the queue by the arbitrary
// `job.project` label, this indexes it by `job.tool`, the key the whole
// `--tool` filter ecosystem uses, and enriches each row with the adapter's
// metadata (display name + the binaries `doctor` looks for on PATH). Kept as
// pure functions here, separate from the commander wiring in cli.ts, so the
// exact output is unit-testable without a store or a clock (the only ambient
// input, `now`, is injectable for the reset countdown).

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
 * Renders the tool index as a table: one row per tool with its adapter display
 * name, total/active/terminal counts, and — when jobs are parked — the soonest
 * reset (with a live countdown). Every registered adapter is listed even with
 * zero jobs so the table doubles as "what can AgentRelay drive?"; unregistered
 * tool ids (from an imported store) are marked with a trailing `(unregistered)`.
 * Pure: no I/O; the only ambient input is `now`, used solely for the countdown
 * and defaulted when omitted. `color` gates ANSI codes (TTY only); a `scopeNote`
 * is echoed once at the top when a filter is active.
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

  if (summary.total === 0 && summary.tools.every((t) => t.total === 0) && options.scopeNote) {
    lines.push(NO_SCOPE_MATCH_MESSAGE);
    return lines.join("\n");
  }

  lines.push(b(`${summary.toolCount} tool(s) with jobs`) + d(` — ${summary.registeredCount} adapter(s) registered`));
  lines.push("");

  const nameWidth = Math.min(20, Math.max(4, ...summary.tools.map((t) => t.tool.length)));
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
    } else if (t.total === 0) {
      reset = d("(no jobs)");
    } else {
      reset = d("(idle)");
    }
    lines.push(`  ${name}  ${total}  ${active}  ${done}  ${reset}`);
    // Second, dimmed line: adapter identity so the table doubles as a registry.
    const bins = t.binaries.length > 0 ? `binaries: ${t.binaries.join(", ")}` : "no binaries";
    const tag = t.registered ? bins : "unregistered";
    lines.push(d(`  ${" ".repeat(nameWidth)}  ${t.displayName} — ${tag}`));
  }

  return lines.join("\n");
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
