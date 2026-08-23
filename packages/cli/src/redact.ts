// Rendering for `agentrelay redact` — scrubbing secrets from already-stored jobs.
//
// The scheduler scrubs an agent's captured output at *write* time (when
// AGENTRELAY_REDACT_OUTPUT is on), but that never reaches jobs persisted before
// redaction existed, imported from an external dump, or hand-edited — nor the
// `lastError`/`lastRateLimit.rawMatch` fields the write-time path leaves raw.
// This command sweeps the whole store once and rewrites those fields in place.
// Kept as pure render functions (separate from the commander wiring in cli.ts)
// so the exact output is unit-testable without a TTY or the store.

import type { StoreRedactionPlan } from "@agentrelay/core";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const MAGENTA = "\x1b[35m";

/**
 * Human-readable summary. When nothing needed scrubbing, says so. Otherwise
 * lists each affected job with which fields were rewritten, then a total line.
 * Pure — takes the plan the queue computed and whether it was a dry run.
 */
export function renderRedact(plan: StoreRedactionPlan, options: { dryRun?: boolean; color?: boolean } = {}): string {
  const dryRun = options.dryRun ?? false;
  const color = options.color ?? false;
  const b = (s: string): string => (color ? `${BOLD}${s}${RESET}` : s);
  const d = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);
  const m = (s: string): string => (color ? `${MAGENTA}${s}${RESET}` : s);

  if (plan.changes.length === 0) {
    return `No secrets found in ${plan.jobs.length} job(s). Nothing to redact.`;
  }

  const marker = dryRun ? "-" : "×";
  const lines: string[] = [];
  for (const change of plan.changes) {
    const id = change.id.slice(0, 8);
    const project = change.project.slice(0, 20).padEnd(20);
    lines.push(`${marker} ${m(id)}  ${project} ${d(change.fields.join(", "))}`);
  }

  const jobNoun = plan.changes.length === 1 ? "job" : "jobs";
  const fieldNoun = plan.totalFields === 1 ? "field" : "fields";
  lines.push(
    dryRun
      ? `Would redact ${b(String(plan.totalFields))} ${fieldNoun} across ${b(String(plan.changes.length))} ${jobNoun}. ${d("No changes made.")}`
      : `Redacted ${b(String(plan.totalFields))} ${fieldNoun} across ${b(String(plan.changes.length))} ${jobNoun}.`
  );
  return lines.join("\n");
}

/**
 * Machine-readable form for `--json` (scripts/jq): the per-job change log plus
 * totals and whether it was a dry run. Job ids are full (not truncated) here.
 */
export function renderRedactJson(
  plan: StoreRedactionPlan,
  storePath: string,
  options: { dryRun?: boolean; generatedAt?: string } = {}
): string {
  const payload = {
    storePath,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    dryRun: options.dryRun ?? false,
    totalJobs: plan.jobs.length,
    changedJobs: plan.changes.length,
    totalFields: plan.totalFields,
    changes: plan.changes.map((c) => ({ id: c.id, project: c.project, fields: c.fields })),
  };
  return JSON.stringify(payload, null, 2);
}
