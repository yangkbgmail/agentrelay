// Rendering helpers for `agentrelay run --dry-run` — a non-executing preview of
// how AgentRelay would classify a command (tool adapter, project label, target
// store, watched rate-limit patterns, reset-horizon guard) without spawning it.
// Pure functions here (separate from the commander wiring in cli.ts) so the
// output is unit-testable without a store, a TTY, or a spawned process.

import type { RunPreview, ToolSource } from "./commands.js";
import { formatCommand } from "./show.js";
import { formatDurationMs } from "./stats.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Label column width so values line up in the preview block. */
const LABEL_WIDTH = 10;

/** Human phrase for how the tool adapter was chosen. */
function toolSourceNote(source: ToolSource): string {
  switch (source) {
    case "explicit":
      return "from --tool";
    case "inferred":
      return "inferred from command";
    default:
      return "generic fallback (no --tool, command not recognized)";
  }
}

/**
 * Render the dry-run preview block for one command as a single string. Pure: no
 * I/O, no ambient clock. Shows exactly the classification `agentrelay run` would
 * apply — the adapter and why, the project label, the store the job would land
 * in, the tool-specific rate-limit patterns watched (on top of the generic
 * ones), and the reset-horizon guard in effect.
 */
export function renderRunPreview(preview: RunPreview, options: { color?: boolean } = {}): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);
  const label = (text: string) => d(text.padEnd(LABEL_WIDTH));

  const lines: string[] = [];
  lines.push(b("agentrelay run --dry-run") + d(" (preview — nothing was executed)"));
  lines.push(`  ${label("command")} ${formatCommand(preview.command)}`);
  lines.push(`  ${label("cwd")} ${preview.cwd}`);
  lines.push(`  ${label("project")} ${preview.project}`);
  lines.push(
    `  ${label("tool")} ${preview.tool} ${d(`(${preview.displayName} — ${toolSourceNote(preview.toolSource)})`)}`
  );
  lines.push(`  ${label("store")} ${preview.storePath}`);

  const patterns =
    preview.extraPatterns.length > 0
      ? `${preview.extraPatterns.join(", ")} ${d("+ generic patterns")}`
      : d("generic patterns only");
  lines.push(`  ${label("patterns")} ${patterns}`);

  const horizon =
    preview.resetHorizonMs === null
      ? d("off (far-future resets are not dropped)")
      : `${formatDurationMs(preview.resetHorizonMs)} ${d("(resets beyond this are dropped as implausible)")}`;
  lines.push(`  ${label("horizon")} ${horizon}`);

  return lines.join("\n");
}

/** Machine-readable dry-run preview for `--json` (scripts, jq, tooling). */
export function renderRunPreviewJson(preview: RunPreview, generatedAt: string = new Date().toISOString()): string {
  return JSON.stringify({ generatedAt, dryRun: true, preview }, null, 2);
}
