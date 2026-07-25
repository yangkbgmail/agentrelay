// Rendering for `agentrelay health` — a one-line, exit-code-driven liveness
// probe for the resume loop. `doctor` runs a full setup diagnostic; `health`
// answers the single question a monitor cares about ("is the loop working when
// it needs to?") fast, so a systemd `ExecStartPre`, a k8s liveness probe, or a
// cron check can branch on the exit code alone. Pure functions (separate from
// the commander wiring in cli.ts) so the output is unit-testable without a store
// or a clock. The verdict/exit-code logic lives in `@agentrelay/core`
// (`evaluateHealth`); this only shapes it for a human/JSON reader.

import type { HealthLevel, HealthReport } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

/** A colored status word + dot per verdict, matching the dashboard's palette. */
const LEVEL_STYLE: Record<HealthLevel, { word: string; color: string }> = {
  healthy: { word: "HEALTHY", color: GREEN },
  idle: { word: "IDLE", color: YELLOW },
  unhealthy: { word: "UNHEALTHY", color: RED },
};

/**
 * One-line human summary: a colored verdict, the core reason, and (when a
 * heartbeat is present) the mode/pid and how long ago it last ticked. Pure — no
 * ambient color unless `color` is passed.
 */
export function renderHealth(report: HealthReport, options: { color?: boolean } = {}): string {
  const color = options.color ?? false;
  const style = LEVEL_STYLE[report.level];
  const verdict = color ? `${BOLD}${style.color}${style.word}${RESET}` : style.word;
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  const hb = report.heartbeat;
  const detail: string[] = [];
  if (hb.mode) detail.push(`${hb.mode}`);
  if (hb.pid !== undefined) detail.push(`pid ${hb.pid}`);
  if (hb.ageMs !== undefined) detail.push(`last tick ${formatDurationMs(hb.ageMs)} ago`);
  const suffix = detail.length > 0 ? `  ${d(`(${detail.join(", ")})`)}` : "";

  return `${verdict}  ${report.reason}${suffix}`;
}

/**
 * Machine-readable form for `--json` (scripts/jq): the verdict, exit code,
 * reason, and the full heartbeat judgment, plus the store it describes and when
 * it was generated.
 */
export function renderHealthJson(
  report: HealthReport,
  storePath: string,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify({ generatedAt, store: storePath, ...report }, null, 2);
}
