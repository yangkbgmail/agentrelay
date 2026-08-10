// Rendering helpers for `agentrelay verify` — a store-integrity lint report.
// The verdict logic lives in `@agentrelay/core`'s `verifyStore`; this file only
// turns a StoreVerification (plus the CLI's file-level state) into human and
// JSON output. Pure so the exact wording is unit-testable without a store.

import type { RepairAction, StoreIssue, StoreRepair, StoreVerification } from "@agentrelay/core";

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

/**
 * Result of `agentrelay verify --fix` — the file-level shape plus, for a verified
 * store, the computed repair and what was actually done with it. Lives here (not
 * in `commands.ts`) so both the runner and the renderer share one type.
 */
export interface VerifyFixReport {
  kind: "missing" | "corrupt" | "verified";
  /** The resolved store path. */
  store: string;
  /** Present when `kind === "corrupt"`. */
  corruptReason?: string;
  /** Present when `kind === "verified"` — the plan (see core `repairStore`). */
  repair?: StoreRepair;
  /** True when this was a preview (`--dry-run`). */
  dryRun?: boolean;
  /** True when the store file was rewritten (false on a clean store or dry run). */
  wrote?: boolean;
  /** The raw pre-repair backup written before rewriting, when one was made. */
  backupPath?: string;
}

const ACTION_LABEL: Record<RepairAction["kind"], string> = {
  "drop-invalid": "drop invalid",
  "drop-duplicate": "drop dup   ",
};

function renderAction(action: RepairAction, color: boolean): string {
  const dim = color ? DIM : "";
  const reset = color ? RESET : "";
  const tag = color ? RED : "";
  const where = action.jobId ? `#${action.index} ${action.jobId}` : `#${action.index}`;
  return `  ${tag}${ACTION_LABEL[action.kind]}${reset} ${dim}[${action.kind}]${reset} ${where}: ${action.reason}`;
}

export const REPAIR_MISSING_MESSAGE = "Job store not found — nothing to repair (it's created on first run).";
export const REPAIR_CLEAN_MESSAGE = "Store is healthy — no error-level problems to repair.";

/**
 * Render a `verify --fix` report as a multi-line block. Pure: no I/O. `color`
 * gates ANSI codes. Shows every dropped record, then a footer stating whether the
 * store was rewritten (and to where the pre-repair backup went) or, for a dry
 * run, that nothing was changed. Warnings are intentionally *not* repaired, so a
 * cleaned store may still carry warnings — the footer points at plain `verify`.
 */
export function renderVerifyFix(report: VerifyFixReport, options: { color?: boolean } = {}): string {
  const color = options.color ?? false;
  const bold = color ? BOLD : "";
  const dim = color ? DIM : "";
  const red = color ? RED : "";
  const green = color ? GREEN : "";
  const yellow = color ? YELLOW : "";
  const reset = color ? RESET : "";

  const lines: string[] = [];
  lines.push(`${bold}Store repair${report.dryRun ? " (dry run)" : ""}${reset}`);
  lines.push(`${dim}store: ${report.store}${reset}`);
  lines.push("");

  if (report.kind === "missing") {
    lines.push(REPAIR_MISSING_MESSAGE);
    return lines.join("\n");
  }
  if (report.kind === "corrupt") {
    lines.push(`${red}error${reset} store file is not a readable JSON array: ${report.corruptReason ?? "unknown"}`);
    lines.push(`${dim}whole-file damage can't be repaired record-by-record; restore from a backup.${reset}`);
    return lines.join("\n");
  }

  const repair = report.repair;
  if (!repair) return lines.join("\n");

  const v = repair.verification;
  if (!repair.changed) {
    lines.push(`${dim}${v.total} record(s) inspected${reset}`);
    lines.push("");
    lines.push(`${green}${REPAIR_CLEAN_MESSAGE}${reset}`);
    if (v.warningCount > 0) {
      lines.push(`${dim}(${v.warningCount} warning(s) remain — run \`agentrelay verify\` to see them.)${reset}`);
    }
    return lines.join("\n");
  }

  const invalid = repair.actions.filter((a) => a.kind === "drop-invalid").length;
  const dups = repair.actions.filter((a) => a.kind === "drop-duplicate").length;
  lines.push(
    `${dim}${v.total} record(s) — ${repair.kept.length} kept, ${repair.actions.length} dropped ` +
      `(${invalid} invalid, ${dups} duplicate)${reset}`
  );
  lines.push("");
  lines.push(repair.actions.map((a) => renderAction(a, color)).join("\n"));
  lines.push("");

  if (report.wrote) {
    lines.push(`${green}Repaired.${reset} Wrote ${repair.kept.length} record(s) back to the store.`);
    if (report.backupPath) lines.push(`${dim}Pre-repair backup: ${report.backupPath}${reset}`);
  } else {
    lines.push(
      `${yellow}Dry run — no changes written.${reset} Re-run without ${bold}--dry-run${reset} to drop ${repair.actions.length} record(s).`
    );
  }
  if (v.warningCount > 0) {
    lines.push(`${dim}(${v.warningCount} warning(s) not repaired — run \`agentrelay verify\` to see them.)${reset}`);
  }
  return lines.join("\n");
}

/** Machine-readable form of the `verify --fix` report for scripts/CI. */
export function renderVerifyFixJson(report: VerifyFixReport): string {
  return JSON.stringify(
    {
      store: report.store,
      kind: report.kind,
      dryRun: Boolean(report.dryRun),
      wrote: Boolean(report.wrote),
      ...(report.backupPath ? { backupPath: report.backupPath } : {}),
      ...(report.kind === "corrupt" ? { corruptReason: report.corruptReason ?? null } : {}),
      ...(report.kind === "verified" && report.repair
        ? {
            changed: report.repair.changed,
            kept: report.repair.kept.length,
            dropped: report.repair.actions.length,
            actions: report.repair.actions,
            verification: report.repair.verification,
          }
        : {}),
    },
    null,
    2
  );
}
