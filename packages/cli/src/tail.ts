// Rendering helpers for `agentrelay tail <id>` — print *only* the captured
// output of a single job (its `lastOutputTail`, the last chunk of the agent's
// stdout/stderr recorded when it finished), with no label/timestamp chrome, so
// it pipes cleanly to grep/less. `show` renders the whole job as a detail
// block; `tail` renders just the bytes. Pure functions here (separate from the
// commander wiring in cli.ts) so the output is unit-testable without a store.

import { countLines, type RelayJob, tailLines } from "@agentrelay/core";

export interface TailRender {
  /** The output text to print to stdout (empty when the job captured none). */
  output: string;
  /** True when the job has no captured output at all (null/empty tail). */
  empty: boolean;
  /** Number of lines in `output` (0 when empty). */
  lines: number;
}

/**
 * Compute the tail output for one job. With `n` set, only the last `n` lines of
 * the captured output are kept; otherwise the whole stored tail is returned.
 * A job that has not produced output yet (queued/waiting, or a null tail)
 * reports `empty: true` so the CLI can print a note instead of a blank line.
 */
export function renderJobTail(job: RelayJob, n?: number): TailRender {
  const full = job.lastOutputTail ?? "";
  if (full === "") return { output: "", empty: true, lines: 0 };
  const output = tailLines(full, n);
  return { output, empty: false, lines: countLines(output) };
}

/** Machine-readable tail for `--json` (scripts, jq, tooling). */
export function renderJobTailJson(job: RelayJob, n?: number, generatedAt: string = new Date().toISOString()): string {
  const full = job.lastOutputTail ?? "";
  const output = tailLines(full, n);
  return JSON.stringify(
    {
      generatedAt,
      id: job.id,
      project: job.project,
      status: job.status,
      lines: full === "" ? 0 : countLines(output),
      output,
    },
    null,
    2
  );
}
