// Rendering helpers for `agentrelay coverage` — how much unattended rate-limit
// waiting the relay covered on your behalf, derived from the per-job detection
// provenance (`lastRateLimit`). Kept as pure functions here, separate from the
// commander wiring in cli.ts, so the exact output is unit-testable without a
// store or a clock.

import type { JobScope, RelayCoverage } from "@agentrelay/core";
import { isJobScopeActive } from "@agentrelay/core";
import { formatDurationMs } from "./stats.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export const NO_COVERAGE_MESSAGE =
  "No rate-limit windows recorded yet. Coverage appears once the relay has parked a job for a reset.";

/** Shown when a `--status`/`--tool`/`--project` scope filters out every window. */
export const NO_COVERAGE_SCOPE_MATCH_MESSAGE = "No rate-limit windows match the current filter.";

/**
 * Renders the coverage summary as a multi-line block. Pure: no I/O, no ambient
 * clock. `color` gates ANSI codes (TTY only). An empty report renders the
 * onboarding hint, or the no-match hint when a scope is active — so a full
 * store with an empty scoped subset never claims "nothing recorded".
 */
export function renderCoverage(coverage: RelayCoverage, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string) => (color ? `${DIM}${s}${RESET}` : s);

  if (coverage.windowCount === 0) {
    return options.scopeNote ? NO_COVERAGE_SCOPE_MATCH_MESSAGE : NO_COVERAGE_MESSAGE;
  }

  const lines: string[] = [];
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));

  lines.push(b(`${formatDurationMs(coverage.totalWaitMs)} of rate-limit wait covered`));
  lines.push(`  across ${coverage.windowCount} window(s) ` + d("(hands-off time the relay absorbed for you)"));

  lines.push("");
  lines.push(b("per window"));
  lines.push(
    `  avg ${formatDurationMs(coverage.avgWaitMs ?? 0)}` +
      `   min ${formatDurationMs(coverage.minWaitMs ?? 0)}` +
      `   max ${formatDurationMs(coverage.maxWaitMs ?? 0)}`
  );
  lines.push(
    `  median ${formatDurationMs(coverage.medianWaitMs ?? 0)}` + `   p90 ${formatDurationMs(coverage.p90WaitMs ?? 0)}`
  );

  if (coverage.longest !== null) {
    const { longest } = coverage;
    lines.push(
      `  longest ${formatDurationMs(longest.waitMs)} ` +
        d(`(${longest.project.slice(0, 24)} · ${longest.pattern} · ${longest.jobId.slice(0, 8)})`)
    );
  }

  if (coverage.byPattern.length > 0) {
    lines.push("");
    lines.push(b("by pattern"));
    for (const p of coverage.byPattern) {
      lines.push(
        `  ${p.pattern.padEnd(22)} ${formatDurationMs(p.totalWaitMs).padStart(8)} ` +
          d(`(${p.count} window${p.count === 1 ? "" : "s"})`)
      );
    }
  }

  return lines.join("\n");
}

/**
 * Machine-readable coverage dump for `--json`. Echoes the active scope (omitted
 * when none) alongside the store path and a generated-at stamp, matching the
 * envelope shape of `renderStatsJson`.
 */
export function renderCoverageJson(
  coverage: RelayCoverage,
  storePath: string,
  options: { generatedAt?: string; scope?: JobScope } = {}
): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const scope = options.scope && isJobScopeActive(options.scope) ? options.scope : undefined;
  return JSON.stringify({ storePath, generatedAt, scope, coverage }, null, 2);
}
