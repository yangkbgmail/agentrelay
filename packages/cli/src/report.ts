// Rendering for `agentrelay report` — one consolidated, shareable snapshot of
// the relay's health: headline stats, top failure reasons, top rate-limit
// patterns, and the next resume, all in a single block. Where `stats`/`errors`/
// `patterns`/`next` each answer one question, `report` stitches them together so
// you can paste "how's my relay doing?" into an issue or standup without running
// four commands. Kept as pure functions here, separate from the commander wiring
// in cli.ts, so the exact output is unit-testable without a store or a clock.

import type { RelayReport } from "@agentrelay/core";
import { formatDurationMs, formatSuccessRate } from "./stats.js";
import { formatCountdown } from "./status.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

export const EMPTY_REPORT_MESSAGE = "No jobs yet. Run `agentrelay run -- <your agent command>` to get started.";

/** Shown when a scope filter matches nothing (the store may still be non-empty). */
export const NO_SCOPE_MATCH_MESSAGE = "No jobs match the current filter.";

/**
 * Render the consolidated report as a multi-line block. Pure: no I/O, no ambient
 * clock (the report already carries `generatedAtMs`). `color` gates ANSI codes
 * (TTY only). `scopeNote`, when set, prints a "scope: …" line and switches the
 * empty message from "no jobs yet" to "nothing matched the filter".
 */
export function renderReport(report: RelayReport, options: { color?: boolean; scopeNote?: string } = {}): string {
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const r = (s: string): string => (color ? `${RED}${s}${RESET}` : s);
  const now = report.generatedAtMs;

  const lines: string[] = [];
  lines.push(b("AgentRelay report"));
  lines.push(d(`generated ${new Date(now).toISOString()}`));
  if (options.scopeNote) lines.push(d(`scope: ${options.scopeNote}`));

  if (report.totalJobs === 0) {
    lines.push("");
    lines.push(options.scopeNote ? NO_SCOPE_MATCH_MESSAGE : EMPTY_REPORT_MESSAGE);
    return lines.join("\n");
  }

  const { stats } = report;

  // Headline: totals + success rate + retries.
  lines.push("");
  lines.push(b(`${report.totalJobs} job(s) tracked`) + d(`  active ${stats.active} · terminal ${stats.terminal}`));
  const resolved = stats.byStatus.completed + stats.byStatus.failed;
  lines.push(
    `  success rate: ${formatSuccessRate(stats.successRate)} ` +
      d(`(${stats.byStatus.completed}/${resolved} resolved; cancelled excluded)`)
  );
  lines.push(`  attempts: ${stats.totalAttempts}   retried jobs: ${stats.retriedJobs}`);
  if (stats.timing.resolvedCount > 0) {
    lines.push(
      `  resolution: median ${formatDurationMs(stats.timing.medianResolutionMs ?? 0)}` +
        `   p90 ${formatDurationMs(stats.timing.p90ResolutionMs ?? 0)} ` +
        d(`over ${stats.timing.resolvedCount} job(s)`)
    );
  }

  // Next resume — the relay's next move.
  lines.push("");
  lines.push(b("next resume"));
  if (report.nextResume === null) {
    lines.push("  none waiting for a reset");
  } else {
    const nr = report.nextResume;
    const countdown = nr.due ? "due now" : `resets in ${formatCountdown(nr.job.resetAt, now)}`;
    const behind = nr.waitingBehind > 0 ? d(`  (+${nr.waitingBehind} behind)`) : "";
    lines.push(`  ${nr.job.id.slice(0, 8)}  ${nr.job.project}  ${countdown}${behind}`);
  }

  // Top failure reasons.
  lines.push("");
  lines.push(b("top errors"));
  if (report.errorTotals.totalWithErrors === 0) {
    lines.push("  none — no jobs have recorded an error");
  } else {
    lines.push(
      d(
        `  ${report.errorTotals.totalWithErrors} job(s) with errors across ` +
          `${report.errorTotals.distinctSignatures} distinct reason(s)`
      )
    );
    for (const group of report.topErrors) {
      const times = group.count === 1 ? "1×" : `${group.count}×`;
      lines.push(`  ${r(times.padEnd(4))} ${group.signature}`);
    }
    const hidden = report.errorTotals.distinctSignatures - report.topErrors.length;
    if (hidden > 0) lines.push(d(`  … ${hidden} more reason(s) — see \`agentrelay errors\``));
  }

  // Top rate-limit patterns.
  lines.push("");
  lines.push(b("top rate-limit patterns"));
  if (report.patternTotals.withDetection === 0) {
    lines.push("  none — no rate-limit detections recorded");
  } else {
    lines.push(d(`  ${report.patternTotals.withDetection}/${report.patternTotals.total} job(s) carry a detection`));
    for (const pat of report.topPatterns) {
      const times = pat.count === 1 ? "1×" : `${pat.count}×`;
      lines.push(`  ${times.padEnd(4)} ${pat.pattern}`);
    }
  }

  return lines.join("\n");
}

/**
 * Machine-readable form of the report for scripts/jq. Includes the store path
 * and echoes an active scope note (if any). The report object is emitted
 * verbatim so `--json` is a lossless view of {@link RelayReport}.
 */
export function renderReportJson(report: RelayReport, store: string, options: { scopeNote?: string } = {}): string {
  return JSON.stringify({ store, scope: options.scopeNote ?? null, report }, null, 2);
}
