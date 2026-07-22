// Rendering helpers for `agentrelay show <id>` — the full detail view of a
// single job that the `status` table can't fit: the exact command, working
// directory, every timestamp, and the last error / captured output tail.
// Pure functions here (separate from the commander wiring in cli.ts) so the
// output is unit-testable without a store, a TTY, or a spawned process.

import type { JobStatus, RelayJob } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";
import { formatCountdown } from "./status.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** ANSI color per status, mirroring the `status` table so the two agree. */
const STATUS_COLOR: Record<JobStatus, string> = {
  queued: "\x1b[36m", // cyan
  waiting_for_reset: "\x1b[33m", // yellow
  resuming: "\x1b[35m", // magenta
  completed: "\x1b[32m", // green
  failed: "\x1b[31m", // red
  cancelled: "\x1b[90m", // gray
};

/** Label column width so values line up in the detail block. */
const LABEL_WIDTH = 10;

/**
 * Quote a single command argument for display so a copy-pasteable line
 * survives args that contain spaces, quotes, or are empty. Not shell-exact
 * (this is a human-readable echo, never re-executed), just unambiguous.
 */
function quoteArg(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"'\\]/.test(arg)) return arg;
  return `"${arg.replace(/(["\\])/g, "\\$1")}"`;
}

/** Render a job's command array back into a readable command line. */
export function formatCommand(command: string[]): string {
  return command.map(quoteArg).join(" ");
}

/**
 * Human annotation for how long after `createdAt` a job was last updated —
 * shown next to the `updated` timestamp so the lifecycle span is visible at a
 * glance. Empty string when either timestamp is unparseable or the span is
 * negative (clock skew), matching how `stats` timing skips such jobs.
 */
function updatedAnnotation(createdAt: string, updatedAt: string): string {
  const created = Date.parse(createdAt);
  const updated = Date.parse(updatedAt);
  if (Number.isNaN(created) || Number.isNaN(updated)) return "";
  const span = updated - created;
  if (span < 0) return "";
  if (span === 0) return " (same as created)";
  return ` (${formatDurationMs(span)} later)`;
}

export interface JobDetailOptions {
  /** Injectable "now" (epoch ms) so the reset countdown is deterministic. */
  now?: number;
  /** Emit ANSI color codes (only makes sense on a TTY). */
  color?: boolean;
}

/**
 * Renders the full detail block for one job as a single string. Pure: no I/O,
 * no ambient clock unless `now` is omitted. The `last error` and `last output`
 * sections are only emitted when the job actually carries that data.
 */
export function renderJobDetail(job: RelayJob, options: JobDetailOptions = {}): string {
  const now = options.now ?? Date.now();
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);
  const label = (text: string) => d(text.padEnd(LABEL_WIDTH));

  const statusCell = color ? `${STATUS_COLOR[job.status] ?? ""}${job.status}${RESET}` : job.status;

  const lines: string[] = [];
  lines.push(b(`Job ${job.id}`));
  lines.push(`  ${label("project")} ${job.project}`);
  if (job.label) lines.push(`  ${label("label")} ${job.label}`);
  lines.push(`  ${label("tool")} ${job.tool}`);
  lines.push(`  ${label("status")} ${statusCell}`);
  lines.push(`  ${label("command")} ${formatCommand(job.command)}`);
  lines.push(`  ${label("cwd")} ${job.cwd}`);
  lines.push(`  ${label("created")} ${job.createdAt}`);
  lines.push(`  ${label("updated")} ${job.updatedAt}${d(updatedAnnotation(job.createdAt, job.updatedAt))}`);
  if (job.resetAt !== null) {
    lines.push(`  ${label("resets in")} ${formatCountdown(job.resetAt, now)} ${d(`(${job.resetAt})`)}`);
  }
  lines.push(`  ${label("attempts")} ${job.attempts}`);

  if (job.lastError) {
    lines.push("");
    lines.push(b("last error"));
    for (const line of job.lastError.split("\n")) lines.push(`  ${line}`);
  }

  if (job.lastOutputTail) {
    lines.push("");
    lines.push(b("last output"));
    for (const line of job.lastOutputTail.split("\n")) lines.push(`  ${line}`);
  }

  return lines.join("\n");
}

/** Machine-readable single-job snapshot for `--json` (scripts, jq, tooling). */
export function renderJobDetailJson(
  job: RelayJob,
  storePath: string,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify({ storePath, generatedAt, job }, null, 2);
}
