// Rendering helpers for `agentrelay verify` — a store-integrity lint report.
// The verdict logic lives in `@agentrelay/core`'s `verifyStore`; this file only
// turns a StoreVerification (plus the CLI's file-level state) into human and
// JSON output. Pure so the exact wording is unit-testable without a store.

import type { StoreIssue, StoreVerification } from "@agentrelay/core";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

export const STORE_MISSING_MESSAGE = "Job store not found — nothing to verify (it's created on first run).";
export const STORE_CLEAN_MESSAGE = "Store is healthy — no integrity problems found.";

/**
 * The three file-level shapes the CLI can hand the renderer:
 *  - `missing`: no store file yet (a clean first-run state).
 *  - `corrupt`: the file exists but isn't a JSON array (whole-file damage;
 *    `verifyStore` operates on records, so this is caught before it runs).
 *  - `verified`: the array parsed and was linted record-by-record.
 */
export interface VerifyReport {
  kind: "missing" | "corrupt" | "verified";
  /** The resolved store path, for the report header/JSON. */
  store: string;
  /** Present when `kind === "corrupt"` — why the file couldn't be read as an array. */
  corruptReason?: string;
  /** Present when `kind === "verified"` — the per-record lint result. */
  verification?: StoreVerification;
}

function renderIssue(issue: StoreIssue, color: boolean): string {
  const dim = color ? DIM : "";
  const reset = color ? RESET : "";
  const tag = color ? (issue.level === "error" ? RED : YELLOW) : "";
  const label = issue.level === "error" ? "error" : "warn ";
  const where = issue.jobId ? `#${issue.index} ${issue.jobId}` : `#${issue.index}`;
  return `  ${tag}${label}${reset} ${dim}[${issue.code}]${reset} ${where}: ${issue.message}`;
}

/**
 * Render a verify report as a multi-line block. Pure: no I/O. `color` gates ANSI
 * codes (TTY only). Errors are listed before warnings; within a level the input
 * order (already index-sorted by `verifyStore`) is preserved.
 */
export function renderVerify(report: VerifyReport, options: { color?: boolean } = {}): string {
  const color = options.color ?? false;
  const bold = color ? BOLD : "";
  const dim = color ? DIM : "";
  const red = color ? RED : "";
  const green = color ? GREEN : "";
  const reset = color ? RESET : "";

  const lines: string[] = [];
  lines.push(`${bold}Store verification${reset}`);
  lines.push(`${dim}store: ${report.store}${reset}`);
  lines.push("");

  if (report.kind === "missing") {
    lines.push(STORE_MISSING_MESSAGE);
    return lines.join("\n");
  }

  if (report.kind === "corrupt") {
    lines.push(`${red}error${reset} store file is not a readable JSON array: ${report.corruptReason ?? "unknown"}`);
    return lines.join("\n");
  }

  const v = report.verification;
  if (!v) return lines.join("\n");

  lines.push(
    `${dim}${v.total} record(s) — ${v.validJobs} valid, ${v.errorCount} error(s), ${v.warningCount} warning(s)${reset}`
  );

  if (v.issues.length === 0) {
    lines.push("");
    lines.push(`${green}${STORE_CLEAN_MESSAGE}${reset}`);
    return lines.join("\n");
  }

  const errors = v.issues.filter((i) => i.level === "error");
  const warnings = v.issues.filter((i) => i.level === "warning");
  if (errors.length > 0) {
    lines.push("");
    lines.push(errors.map((i) => renderIssue(i, color)).join("\n"));
  }
  if (warnings.length > 0) {
    lines.push("");
    lines.push(warnings.map((i) => renderIssue(i, color)).join("\n"));
  }

  return lines.join("\n");
}

/**
 * Machine-readable form of the verify report for scripts/CI. Always includes the
 * store path and a `kind`; for a verified store it inlines the full
 * StoreVerification. Pretty-printed (the console.log adds the trailing newline).
 */
export function renderVerifyJson(report: VerifyReport): string {
  return JSON.stringify(
    {
      store: report.store,
      kind: report.kind,
      ...(report.kind === "corrupt" ? { corruptReason: report.corruptReason ?? null } : {}),
      ...(report.kind === "verified" && report.verification ? { verification: report.verification } : {}),
    },
    null,
    2
  );
}
