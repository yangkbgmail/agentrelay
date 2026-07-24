// Rendering helpers for `agentrelay diff` — the delta between a backup snapshot
// and the current store. Kept as pure functions here, separate from the
// commander wiring in cli.ts, so the exact output is unit-testable without a
// store. The actual snapshot/store reads live in commands.ts (`diffStore`).

import type { FieldChange, JobChange, RelayJob, StoreDiff } from "@agentrelay/core";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

export const NO_DIFF_MESSAGE = "No changes: the snapshot and the current store are identical.";

/** Short, stable label for a job in a diff row: short id + project. */
function jobLabel(job: RelayJob): string {
  return `${job.id.slice(0, 8)} ${job.project}`;
}

/** Render a scalar field value for the human diff (null → "none"). */
function renderValue(value: string | number | null): string {
  return value === null ? "none" : String(value);
}

/** One "field: before → after" line for a changed job. */
function renderFieldChange(change: FieldChange): string {
  return `${change.field}: ${renderValue(change.before)} → ${renderValue(change.after)}`;
}

function renderAdded(jobs: RelayJob[], color: boolean): string[] {
  const green = color ? GREEN : "";
  const reset = color ? RESET : "";
  return jobs.map((job) => `${green}+ ${jobLabel(job)} (${job.status})${reset}`);
}

function renderRemoved(jobs: RelayJob[], color: boolean): string[] {
  const red = color ? RED : "";
  const reset = color ? RESET : "";
  return jobs.map((job) => `${red}- ${jobLabel(job)} (${job.status})${reset}`);
}

function renderChanged(changes: JobChange[], color: boolean): string[] {
  const yellow = color ? YELLOW : "";
  const dim = color ? DIM : "";
  const reset = color ? RESET : "";
  return changes.map((change) => {
    const header = `${yellow}~ ${jobLabel(change.after)}${reset}`;
    const details = change.changes.map((c) => `    ${dim}${renderFieldChange(c)}${reset}`);
    return [header, ...details].join("\n");
  });
}

/**
 * Renders the full store diff as a multi-line block. Pure: no I/O. `color`
 * gates ANSI codes (TTY only). `from`, when set, is echoed as the snapshot the
 * current store is compared against.
 */
export function renderStoreDiff(diff: StoreDiff, options: { color?: boolean; from?: string } = {}): string {
  const color = options.color ?? false;
  const bold = color ? BOLD : "";
  const dim = color ? DIM : "";
  const reset = color ? RESET : "";

  const lines: string[] = [];
  lines.push(`${bold}Store diff${reset}`);
  if (options.from) lines.push(`${dim}against: ${options.from}${reset}`);

  const changedCount = diff.changed.length;
  lines.push(
    `${dim}+${diff.added.length} added  -${diff.removed.length} removed  ` +
      `~${changedCount} changed  =${diff.unchanged} unchanged${reset}`
  );

  if (diff.added.length === 0 && diff.removed.length === 0 && changedCount === 0) {
    lines.push("");
    lines.push(NO_DIFF_MESSAGE);
    return lines.join("\n");
  }

  const blocks = [
    ...renderAdded(diff.added, color),
    ...renderRemoved(diff.removed, color),
    ...renderChanged(diff.changed, color),
  ];
  lines.push("");
  lines.push(blocks.join("\n"));
  return lines.join("\n");
}

/**
 * Machine-readable form of the diff for scripts/jq. Echoes the compared
 * snapshot path and full added/removed/changed shapes. Pretty-printed.
 */
export function renderStoreDiffJson(diff: StoreDiff, options: { from?: string } = {}): string {
  return JSON.stringify(
    {
      from: options.from ?? null,
      counts: {
        added: diff.added.length,
        removed: diff.removed.length,
        changed: diff.changed.length,
        unchanged: diff.unchanged,
      },
      added: diff.added,
      removed: diff.removed,
      changed: diff.changed,
    },
    null,
    2
  );
}
