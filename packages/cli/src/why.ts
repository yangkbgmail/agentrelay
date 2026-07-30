// Rendering helpers for `agentrelay why <id>` — turn the pure {@link JobExplanation}
// from @agentrelay/core into a human block or a `--json` payload. Kept separate
// from the commander wiring in cli.ts so the formatting is unit-testable
// without a store or a TTY.

import type { JobExplanation } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** ANSI color per disposition, greening the good states and reddening failure. */
const DISPOSITION_COLOR: Record<JobExplanation["disposition"], string> = {
  queued: "\x1b[36m", // cyan
  waiting: "\x1b[33m", // yellow
  due: "\x1b[35m", // magenta — actionable now
  resuming: "\x1b[35m", // magenta
  completed: "\x1b[32m", // green
  failed: "\x1b[31m", // red
  cancelled: "\x1b[90m", // gray
};

export interface RenderExplanationOptions {
  /** Emit ANSI color codes (only makes sense on a TTY). */
  color?: boolean;
}

/**
 * Render the explanation as a compact block: a colored headline, the supporting
 * reasons as bullets, an optional "resumes in" countdown, and the suggested
 * next action. Pure — no I/O, no ambient clock.
 */
export function renderExplanation(explanation: JobExplanation, options: RenderExplanationOptions = {}): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);
  const tint = (s: string) => (color ? `${DISPOSITION_COLOR[explanation.disposition] ?? ""}${s}${RESET}` : s);

  const lines: string[] = [];
  lines.push(`${b(`Job ${explanation.id}`)} ${d(`[${explanation.disposition}]`)}`);
  lines.push(tint(explanation.headline));

  if (explanation.resumesInMs !== null) {
    const when = explanation.resumesInMs <= 0 ? "due now" : `in ${formatDurationMs(explanation.resumesInMs)}`;
    lines.push(`  ${d("resumes")} ${when}`);
  }

  for (const reason of explanation.reasons) {
    lines.push(`  ${d("•")} ${reason}`);
  }

  lines.push("");
  lines.push(`${b("→")} ${explanation.nextAction}`);

  return lines.join("\n");
}

/** Machine-readable explanation for `--json` (scripts, dashboards, tooling). */
export function renderExplanationJson(
  explanation: JobExplanation,
  storePath: string,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify({ storePath, generatedAt, explanation }, null, 2);
}
