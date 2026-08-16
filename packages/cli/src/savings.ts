// Rendering for `agentrelay savings` — the product's payoff, in one glance:
// how many manual restarts the relay absorbed and how much wall-clock it
// carried unattended across rate-limit windows. Where `stats` answers "how is
// the relay doing?", `savings` answers "was running it worth it?". Kept as pure
// functions (separate from the commander wiring) so the output is testable
// without a TTY, a clock, or a spawned process.

import type { RelayValue } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

/** Shown when the relay has never had to step in (no job was auto-resumed). */
export const NO_SAVINGS_MESSAGE = "AgentRelay hasn't had to step in yet — no rate-limited job has been auto-resumed.";

/** Shown when a scope filter matches jobs but none were auto-resumed. */
export const NO_SAVINGS_MATCH_MESSAGE = "No matching jobs were auto-resumed by the relay.";

/**
 * Render the relay-value block as multi-line human output. Pure: no I/O, no
 * ambient clock. `color` gates ANSI codes (TTY only). `scopeNote`, when set,
 * prints a "scope: …" line and switches the empty message to the match variant.
 */
export function renderSavings(value: RelayValue, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const g = (s: string): string => (color ? `${GREEN}${s}${RESET}` : s);

  const lines: string[] = [b("Relay value — what AgentRelay did for you")];
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));
  lines.push("");

  if (value.autoResumes === 0) {
    lines.push(options.scopeNote ? NO_SAVINGS_MATCH_MESSAGE : NO_SAVINGS_MESSAGE);
    return lines.join("\n");
  }

  const jobsWord = value.resumedJobs === 1 ? "job" : "jobs";
  const restartsWord = value.manualInterventionsSaved === 1 ? "restart" : "restarts";

  lines.push(
    `  Auto-resumes            ${g(String(value.autoResumes))}   ${d(`(across ${value.resumedJobs} ${jobsWord})`)}`
  );
  lines.push(`  Manual ${restartsWord} saved   ${g(String(value.manualInterventionsSaved))}`);

  if (value.unattendedJobs > 0) {
    const spanJobsWord = value.unattendedJobs === 1 ? "job" : "jobs";
    lines.push(
      `  Unattended time         ${g(formatDurationMs(value.unattendedMs))}   ` +
        d(`(over ${value.unattendedJobs} resolved ${spanJobsWord})`)
    );
    lines.push(`  Longest single save     ${g(formatDurationMs(value.longestUnattendedMs))}`);
  } else {
    // Jobs were resumed but none have resolved yet, so there's no final span to
    // report — say so rather than printing a misleading "<1s".
    lines.push(d("  Unattended time         (no resumed job has resolved yet)"));
  }

  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq). Carries the full
 * {@link RelayValue} plus the store path and an optional scope note.
 */
export function renderSavingsJson(
  value: RelayValue,
  storePath: string,
  options: { scopeNote?: string; generatedAt?: string } = {}
): string {
  return JSON.stringify(
    {
      storePath,
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      scope: options.scopeNote ?? null,
      value,
    },
    null,
    2
  );
}
