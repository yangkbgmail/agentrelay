// Rendering helpers for `agentrelay doctor` — a health check of the effective
// configuration and environment. Pure functions, separate from the commander
// wiring in cli.ts and the I/O gathering in commands.ts, so the exact output is
// unit-testable without a real environment.

import type { CheckStatus, DoctorReport } from "@agentrelay/core";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

const ICON: Record<CheckStatus, string> = { ok: "✓", warn: "!", error: "✗" };
const COLOR: Record<CheckStatus, string> = { ok: GREEN, warn: YELLOW, error: RED };

/**
 * Renders the doctor report as a multi-line block, one line per check plus a
 * summary. Pure: no I/O. `color` gates ANSI codes (TTY only).
 */
export function renderDoctor(report: DoctorReport, options: { color?: boolean } = {}): string {
  const color = options.color ?? false;
  const paint = (status: CheckStatus, s: string) => (color ? `${COLOR[status]}${s}${RESET}` : s);
  const bold = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);

  const lines: string[] = [];
  for (const check of report.checks) {
    const marker = paint(check.status, ICON[check.status]);
    lines.push(`${marker} ${check.name.padEnd(10)} ${check.detail}`);
  }

  const errors = report.checks.filter((c) => c.status === "error").length;
  const warns = report.checks.filter((c) => c.status === "warn").length;
  lines.push("");
  if (report.ok) {
    lines.push(bold(warns > 0 ? `All critical checks passed (${warns} warning(s)).` : "All checks passed."));
  } else {
    lines.push(bold(`${errors} problem(s) found — see above.`));
  }
  return lines.join("\n");
}

/** Machine-readable snapshot for `--json` (scripts, jq, CI gating). */
export function renderDoctorJson(
  report: DoctorReport,
  storePath: string,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify({ storePath, generatedAt, ok: report.ok, checks: report.checks }, null, 2);
}
