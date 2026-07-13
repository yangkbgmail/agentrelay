// Rendering helpers for `agentrelay logs <id>` — a full, untruncated detail
// view of a single job. `agentrelay status` is deliberately terse (a fixed-
// width table that clips the project name and hides the command, cwd, and the
// captured output/error tail); when you're debugging *why* a particular relay
// failed you want all of it. Kept as pure functions here — separate from the
// commander wiring in cli.ts — so the exact output is unit-testable without a
// TTY, a clock, or a spawned process.

import type { RelayJob } from "@agentrelay/core";
import { formatCountdown } from "./status.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

/** ANSI color per lifecycle status, applied only when writing to a TTY. */
const STATUS_COLOR: Record<string, string> = {
  queued: "\x1b[36m", // cyan
  waiting_for_reset: "\x1b[33m", // yellow
  resuming: "\x1b[35m", // magenta
  completed: "\x1b[32m", // green
  failed: "\x1b[31m", // red
  cancelled: "\x1b[90m", // gray
};

export interface RenderJobOptions {
  /** Injectable "now" (epoch ms) so the reset countdown is deterministic. */
  now?: number;
  /** Emit ANSI color codes (only makes sense on a TTY). */
  color?: boolean;
}

/**
 * Render a command argv the way a user would type it: bare tokens joined by
 * spaces, but any token containing whitespace, quotes, or shell-special
 * characters wrapped in single quotes (with embedded single quotes escaped).
 * This is for *display only* — it is not fed back to a shell.
 */
export function formatCommand(command: string[]): string {
  if (command.length === 0) return "-";
  return command
    .map((arg) => {
      if (arg.length === 0) return "''";
      if (/^[A-Za-z0-9_./:@%+=-]+$/.test(arg)) return arg;
      return `'${arg.replace(/'/g, "'\\''")}'`;
    })
    .join(" ");
}

/**
 * The full detail block for one job. Every field the store holds is shown in
 * full — no truncation — with the command quoted for readability and the
 * captured output/error tails printed verbatim (indented) at the end.
 */
export function renderJobDetail(job: RelayJob, options: RenderJobOptions = {}): string {
  const now = options.now ?? Date.now();
  const color = options.color ?? false;

  const label = (text: string) => (color ? `${DIM}${text}${RESET}` : text);
  const statusValue = color ? `${STATUS_COLOR[job.status] ?? ""}${job.status}${RESET}` : job.status;

  const resetsIn = formatCountdown(job.resetAt, now);
  const resetLine = job.resetAt ? `${resetsIn} (${job.resetAt})` : resetsIn;

  const rows: Array<[string, string]> = [
    ["project", job.project],
    ["tool", job.tool],
    ["status", statusValue],
    ["command", formatCommand(job.command)],
    ["cwd", job.cwd],
    ["created", job.createdAt],
    ["updated", job.updatedAt],
    ["resets in", resetLine],
    ["attempts", String(job.attempts)],
  ];

  const width = rows.reduce((max, [key]) => Math.max(max, key.length), 0);
  const heading = color ? `${BOLD}Job ${job.id}${RESET}` : `Job ${job.id}`;
  const lines = [heading, ...rows.map(([key, value]) => `  ${label(key.padEnd(width))}  ${value}`)];

  // Last error and the captured output tail are potentially multi-line, so
  // give them their own indented blocks rather than cramming them into a row.
  lines.push("", `${label("last error:")}`);
  lines.push(indentBlock(job.lastError));
  lines.push("", `${label("last output:")}`);
  lines.push(indentBlock(job.lastOutputTail));

  return lines.join("\n");
}

/** Indent a possibly-null, possibly-multi-line block by two spaces; "-" if empty. */
function indentBlock(text: string | null): string {
  if (text === null || text.trim() === "") return "  -";
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

/**
 * Machine-readable single-job snapshot for `logs --json`. Mirrors the envelope
 * shape used by `status --json` (storePath + generatedAt + payload) so scripts
 * can treat both the same way.
 */
export function renderJobDetailJson(
  job: RelayJob,
  storePath: string,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify({ storePath, generatedAt, job }, null, 2);
}
