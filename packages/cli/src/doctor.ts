import type { DiagnosticCheck, DiagnosticLevel, DiagnosticReport } from "@agentrelay/core";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Status glyph + color for each level. Plain ASCII so it renders everywhere. */
const LEVEL_META: Record<DiagnosticLevel, { symbol: string; color: string; label: string }> = {
  ok: { symbol: "✔", color: GREEN, label: "ok" },
  warning: { symbol: "!", color: YELLOW, label: "warn" },
  error: { symbol: "✖", color: RED, label: "fail" },
};

/**
 * Renders a {@link DiagnosticReport} as an aligned, colorized checklist for
 * `agentrelay doctor`. Pure: no I/O. `color` gates ANSI codes (TTY only), so
 * piped/redirected output stays clean. Each problem line is followed by an
 * indented hint when one is present.
 */
export function renderDoctor(report: DiagnosticReport, options: { color?: boolean } = {}): string {
  const color = options.color ?? false;
  const paint = (code: string, s: string) => (color ? `${code}${s}${RESET}` : s);

  const lines: string[] = [];
  lines.push(paint(BOLD, "agentrelay doctor"));

  const nameWidth = Math.max(...report.checks.map((c) => c.name.length));
  for (const check of report.checks) {
    lines.push(renderCheck(check, nameWidth, color));
  }

  lines.push("");
  lines.push(renderSummary(report, color));
  return lines.join("\n");
}

function renderCheck(check: DiagnosticCheck, nameWidth: number, color: boolean): string {
  const meta = LEVEL_META[check.level];
  const paint = (code: string, s: string) => (color ? `${code}${s}${RESET}` : s);
  const symbol = paint(meta.color, meta.symbol);
  const name = check.name.padEnd(nameWidth);
  let line = `  ${symbol} ${paint(BOLD, name)}  ${check.message}`;
  if (check.hint && check.level !== "ok") {
    line += `\n    ${paint(DIM, `↳ ${check.hint}`)}`;
  }
  return line;
}

function renderSummary(report: DiagnosticReport, color: boolean): string {
  const paint = (code: string, s: string) => (color ? `${code}${s}${RESET}` : s);
  const { ok, warning, error } = report.counts;
  const parts = [paint(GREEN, `${ok} ok`), paint(YELLOW, `${warning} warning`), paint(RED, `${error} error`)];
  const verdict = report.ok
    ? paint(GREEN, error === 0 && warning === 0 ? "all healthy" : "healthy (with warnings)")
    : paint(RED, "problems found");
  return `${parts.join("  ")}  —  ${paint(BOLD, verdict)}`;
}

/** Machine-readable snapshot for `doctor --json` (scripts, CI, monitoring). */
export function renderDoctorJson(report: DiagnosticReport, generatedAt: string = new Date().toISOString()): string {
  return JSON.stringify({ generatedAt, ...report }, null, 2);
}
