// Rendering for `agentrelay diff` — the delta between a snapshot and the current
// store. `backup`/`restore` move the store between point-in-time states and
// `export`/`import` move it between machines; this answers the question that
// naturally follows either — *what actually changed?* (which jobs appeared,
// disappeared, or moved status/reset/attempts). Pure functions (separate from
// the commander wiring in cli.ts and the filesystem read in commands.ts) so the
// output is unit-testable without touching disk or a TTY.

import type { JobChange, RelayJob, StoreDiff } from "@agentrelay/core";
import { isStoreDiffEmpty } from "@agentrelay/core";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const shortId = (id: string): string => id.slice(0, 8);

/** One line describing a job that appeared or disappeared: `id  project  status`. */
function jobLine(job: RelayJob): string {
  return `${shortId(job.id)}  ${job.project}  ${job.status}`;
}

/** Lines describing a changed job: a header, then one `field: before → after` per change. */
function changeLines(change: JobChange, arrow: string): string[] {
  const lines = [`${shortId(change.id)}  ${change.project}`];
  for (const c of change.changes) {
    lines.push(`    ${c.field}: ${c.before} ${arrow} ${c.after}`);
  }
  return lines;
}

/**
 * Human-readable diff: an `+ added` / `- removed` / `~ changed` section (each
 * omitted when empty), then a one-line summary. When nothing differs, a single
 * "No differences" line — the store matches the snapshot. Pure: no ambient
 * color unless `color` is passed.
 */
export function renderDiff(diff: StoreDiff, options: { color?: boolean; from?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const g = (s: string): string => (color ? `${GREEN}${s}${RESET}` : s);
  const r = (s: string): string => (color ? `${RED}${s}${RESET}` : s);
  const y = (s: string): string => (color ? `${YELLOW}${s}${RESET}` : s);
  const arrow = color ? `${DIM}→${RESET}` : "→";

  const header = options.from ? `${b("Store diff")} ${d(`(${options.from} → current store)`)}` : b("Store diff");
  const lines: string[] = [header];

  if (isStoreDiffEmpty(diff)) {
    lines.push(d("  No differences — the store matches the snapshot."));
    return lines.join("\n");
  }

  if (diff.added.length > 0) {
    lines.push(g(`+ Added (${diff.added.length})`));
    for (const job of diff.added) lines.push(g(`  + ${jobLine(job)}`));
  }
  if (diff.removed.length > 0) {
    lines.push(r(`- Removed (${diff.removed.length})`));
    for (const job of diff.removed) lines.push(r(`  - ${jobLine(job)}`));
  }
  if (diff.changed.length > 0) {
    lines.push(y(`~ Changed (${diff.changed.length})`));
    for (const change of diff.changed) {
      const [head, ...rest] = changeLines(change, arrow);
      lines.push(y(`  ~ ${head}`));
      for (const line of rest) lines.push(d(line));
    }
  }

  lines.push(
    d(
      `${diff.beforeCount} → ${diff.afterCount} job(s): ` +
        `+${diff.added.length} added, -${diff.removed.length} removed, ` +
        `~${diff.changed.length} changed, ${diff.unchangedCount} unchanged.`
    )
  );
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq): the full diff plus the
 * snapshot it was compared against and when it was generated.
 */
export function renderDiffJson(diff: StoreDiff, options: { from?: string; generatedAt?: string } = {}): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  return JSON.stringify({ generatedAt, from: options.from ?? null, ...diff }, null, 2);
}
