// Rendering for `agentrelay diff` — a human/JSON view of what changed between
// two job-store snapshots (or a snapshot and the current queue). Where `status`
// dumps one queue and `show` inspects one job, `diff` answers "what moved while
// I was away?": jobs added, removed, or with a changed status/attempts/reset.
// Pure functions here (separate from the commander wiring and the filesystem
// reads in commands.ts) so the output is unit-testable without a store or TTY.

import type { JobChange, JobDiff, RelayJob } from "@agentrelay/core";
import { isEmptyDiff } from "@agentrelay/core";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Shown when the two snapshots are identical across every tracked field. */
export const NO_DIFF_MESSAGE = "No differences.";

/** Labels naming the two sides being compared (for the header line). */
export interface DiffLabels {
  /** The earlier snapshot's name (e.g. a backup filename). */
  before: string;
  /** The later snapshot's name, or "current store". */
  after: string;
}

const shortId = (id: string): string => id.slice(0, 8);

function fmtValue(v: string | number | null): string {
  return v === null ? "∅" : String(v);
}

/**
 * Human-friendly diff report: a header naming both sides, then `+ added`,
 * `- removed`, and `~ changed` sections (each omitted when empty), and a
 * trailing count of unchanged jobs. Colors (green/red/yellow) are opt-in so
 * piped output stays plain. Pure: no clock, no ambient state.
 */
export function renderDiff(diff: JobDiff, labels: DiffLabels, options: { color?: boolean } = {}): string {
  const color = options.color ?? false;
  const g = (s: string): string => (color ? `${GREEN}${s}${RESET}` : s);
  const r = (s: string): string => (color ? `${RED}${s}${RESET}` : s);
  const y = (s: string): string => (color ? `${YELLOW}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);

  const lines: string[] = [];
  lines.push(`${b(labels.before)} ${d("→")} ${b(labels.after)}`);

  if (isEmptyDiff(diff)) {
    lines.push("");
    lines.push(`${NO_DIFF_MESSAGE} ${d(`(${diff.unchanged} unchanged)`)}`.trimEnd());
    return lines.join("\n");
  }

  const jobLine = (job: RelayJob): string => `  ${job.id.slice(0, 8)}  ${job.project}  ${d(job.status)}`;

  if (diff.added.length > 0) {
    lines.push("");
    lines.push(g(`+ added (${diff.added.length})`));
    for (const job of diff.added) lines.push(g(jobLine(job)));
  }
  if (diff.removed.length > 0) {
    lines.push("");
    lines.push(r(`- removed (${diff.removed.length})`));
    for (const job of diff.removed) lines.push(r(jobLine(job)));
  }
  if (diff.changed.length > 0) {
    lines.push("");
    lines.push(y(`~ changed (${diff.changed.length})`));
    for (const change of diff.changed) {
      lines.push(y(`  ${shortId(change.id)}  ${change.after.project}`));
      for (const f of change.fields) {
        lines.push(`    ${f.field}: ${d(fmtValue(f.before))} ${d("→")} ${fmtValue(f.after)}`);
      }
    }
  }

  lines.push("");
  lines.push(d(`${diff.unchanged} unchanged.`));
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq): the labels being compared
 * plus the full {@link JobDiff}. `generatedAt` is stamped for provenance.
 */
export function renderDiffJson(
  diff: JobDiff,
  labels: DiffLabels,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify({ before: labels.before, after: labels.after, generatedAt, diff }, null, 2);
}

/** Re-exported for callers that only want the type. */
export type { JobChange };
