// Rendering for `agentrelay tick --dry-run` — the read-only preview of a
// scheduler pass. `tick` (no flag) actually spawns the due agent commands;
// `--dry-run` instead reports exactly which jobs *would* be resumed so an
// operator can pre-flight a pass (e.g. before wiring cron) without side effects.
// The selection mirrors the scheduler's `listDue`, so this is a faithful "here
// is what will happen" rather than an approximation. Kept as pure functions
// (separate from the commander wiring) so the output is testable without a TTY,
// a clock, or a spawned process.

import type { TickPlan } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Shown when a dry-run finds nothing due — the tick would resume no jobs. */
export const NO_DUE_MESSAGE = "No jobs due — a tick right now would resume nothing.";

/**
 * Human-friendly multi-line table for a tick plan: one row per job the tick
 * would resume (short id, project, tool, how long it has been due, its reset
 * time), a header, and a footer with the total. Reuses `formatDurationMs` so
 * "2h 5m"/"3d 4h" match the rest of the CLI. Pure — every span comes precomputed
 * in the plan.
 */
export function renderTickPlan(plan: TickPlan, options: { color?: boolean } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  if (plan.resumes.length === 0) {
    return NO_DUE_MESSAGE;
  }

  const projWidth = Math.min(28, Math.max(7, ...plan.resumes.map((r) => r.job.project.length)));
  const toolWidth = Math.min(14, Math.max(4, ...plan.resumes.map((r) => r.job.tool.length)));
  const lines: string[] = [];

  lines.push(
    b(`${pad("ID", 8)}  ${pad("PROJECT", projWidth)}  ${pad("TOOL", toolWidth)}  ${pad("DUE FOR", 10)}  RESET AT`)
  );

  for (const entry of plan.resumes) {
    const id = pad(entry.job.id.slice(0, 8), 8);
    const project = pad(truncate(entry.job.project, projWidth), projWidth);
    const tool = pad(truncate(entry.job.tool, toolWidth), toolWidth);
    const due = pad(entry.overdueByMs > 0 ? formatDurationMs(entry.overdueByMs) : "now", 10);
    lines.push(`${b(id)}  ${project}  ${tool}  ${due}  ${d(entry.job.resetAt ?? "-")}`);
  }

  lines.push("");
  lines.push(d(footer(plan)));
  return lines.join("\n");
}

/**
 * Machine-readable form for `--dry-run --json` (scripts/jq). Carries the store
 * path, a generation timestamp, and the full plan — the resumes plus the total
 * and the reference time the plan was computed against.
 */
export function renderTickPlanJson(input: { storePath: string; generatedAt?: string; plan: TickPlan }): string {
  return JSON.stringify(
    {
      storePath: input.storePath,
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      dryRun: true,
      plan: input.plan,
    },
    null,
    2
  );
}

function footer(plan: TickPlan): string {
  const jobWord = plan.total === 1 ? "job" : "jobs";
  return `${plan.total} ${jobWord} would resume this tick.\nRun \`agentrelay tick\` (without --dry-run) to resume them.`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, Math.max(1, width - 1))}…`;
}
