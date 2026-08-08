// Rendering for `agentrelay diff` — a human/scriptable view of what changed in
// the job store since a snapshot. Where `restore --dry-run` reports only counts
// (N jobs would replace M), `diff` shows *which* jobs appeared, vanished, or
// mutated — the read-only complement to the backup/restore family. Pure render
// functions (separate from commander wiring) so the output is testable without
// a filesystem or a TTY; the core `diffJobs` does the comparison.

import type { ChangedJob, JobsDiff, RelayJob } from "@agentrelay/core";
import { isEmptyDiff } from "@agentrelay/core";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";

/** Shown when the snapshot and the current store are identical. */
export const NO_DIFF_MESSAGE = "No differences — the store matches the snapshot.";

function shortId(id: string): string {
  return id.slice(0, 8);
}

/** `null`/`undefined` render as a dim `-`; everything else stringifies verbatim. */
function fieldValue(value: unknown): string {
  if (value === null || value === undefined) return "∅";
  return String(value);
}

/**
 * Human-readable diff: a one-line summary (`+N added  -N removed  ~N changed
 * =N unchanged`) followed by per-section detail. Added/removed jobs show
 * id/project/status; changed jobs list each differing field as `field: before →
 * after`. Returns {@link NO_DIFF_MESSAGE} when nothing differs. Pure: no clock,
 * no filesystem.
 */
export function renderDiff(diff: JobsDiff, options: { from?: string; color?: boolean } = {}): string {
  const color = options.color ?? false;
  const c = (code: string, s: string): string => (color ? `${code}${s}${RESET}` : s);
  const dim = (s: string): string => c(DIM, s);

  const lines: string[] = [];
  if (options.from) {
    lines.push(dim(`snapshot: ${options.from}`));
    lines.push("");
  }

  const summary = [
    c(GREEN, `+${diff.added.length} added`),
    c(RED, `-${diff.removed.length} removed`),
    c(YELLOW, `~${diff.changed.length} changed`),
    dim(`=${diff.unchanged} unchanged`),
  ].join("   ");
  lines.push(summary);

  if (isEmptyDiff(diff)) {
    lines.push("");
    lines.push(NO_DIFF_MESSAGE);
    return lines.join("\n");
  }

  if (diff.added.length > 0) {
    lines.push("");
    lines.push(c(BOLD, "added:"));
    for (const job of diff.added) lines.push(c(GREEN, `  + ${jobLine(job)}`));
  }
  if (diff.removed.length > 0) {
    lines.push("");
    lines.push(c(BOLD, "removed:"));
    for (const job of diff.removed) lines.push(c(RED, `  - ${jobLine(job)}`));
  }
  if (diff.changed.length > 0) {
    lines.push("");
    lines.push(c(BOLD, "changed:"));
    for (const change of diff.changed) {
      lines.push(c(YELLOW, `  ~ ${shortId(change.id)}  ${change.after.project}`));
      for (const line of changeLines(change)) lines.push(dim(`      ${line}`));
    }
  }

  return lines.join("\n");
}

function jobLine(job: RelayJob): string {
  return `${shortId(job.id)}  ${job.project}  ${job.status}`;
}

function changeLines(change: ChangedJob): string[] {
  return change.changes.map((f) => `${f.field}: ${fieldValue(f.before)} → ${fieldValue(f.after)}`);
}

/**
 * Machine-readable form for `--json` (scripts/jq): the snapshot path, when the
 * diff was generated, and the full {@link JobsDiff} (added/removed jobs and
 * per-field changes). Pure aside from the default timestamp.
 */
export function renderDiffJson(diff: JobsDiff, from: string, generatedAt: string = new Date().toISOString()): string {
  return JSON.stringify({ from, generatedAt, diff }, null, 2);
}
