// Rendering for `agentrelay paths` — a plain "where does AgentRelay keep my
// stuff?" report. `config show` prints effective *settings* and `doctor`
// *judges health*; this answers the more basic "which files on disk does the
// tool read/write, and do they exist yet?" — the first thing to check when a
// job silently isn't resuming and you're unsure you're even looking at the
// right store. Pure functions (separate from the commander wiring in cli.ts) so
// the output is unit-testable without touching disk or a TTY.

import type { LocationEntry, LocationReport } from "@agentrelay/core";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/** Wider than the longest label ("Daemon heartbeat:") so the path column always
 * clears the labels with at least one space of gutter. */
const LABEL_WIDTH = 18;

/**
 * A one-character presence marker for an entry. `✓` = exists, `·` = not there
 * yet (which is usually fine — the store/heartbeat are created on first use).
 */
function marker(entry: LocationEntry, color: boolean): string {
  if (entry.exists) return color ? `${GREEN}✓${RESET}` : "✓";
  return color ? `${DIM}·${RESET}` : "·";
}

/**
 * Human-readable block: one line per location with a presence marker, the path,
 * and (when notable) a dim note explaining an absent or derived path. Pure — no
 * ambient color unless `color` is passed.
 */
export function renderLocations(report: LocationReport, options: { color?: boolean } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const y = (s: string): string => (color ? `${YELLOW}${s}${RESET}` : s);

  const lines: string[] = [b("AgentRelay file locations")];
  for (const entry of report.entries) {
    const label = `${entry.label}:`.padEnd(LABEL_WIDTH);
    const path = entry.path ?? d("(none)");
    // A resolved-but-missing config is the one note worth a warning color; the
    // rest are benign "not created yet" states.
    const noteColor = entry.note?.includes("missing") ? y : d;
    const note = entry.note ? `  ${noteColor(`— ${entry.note}`)}` : "";
    lines.push(`  ${marker(entry, color)} ${label}${path}${note}`);
  }
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq): the full report plus the
 * store it describes and when it was generated.
 */
export function renderLocationsJson(report: LocationReport, generatedAt: string = new Date().toISOString()): string {
  return JSON.stringify({ generatedAt, ...report }, null, 2);
}
