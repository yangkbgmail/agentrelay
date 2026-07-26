// Rendering helpers for `agentrelay tail <id>` — dump the raw captured output
// tail of a single job (`lastOutputTail`), the way `tail -f` / `less` would,
// for piping and quick debugging. Unlike `agentrelay show`, which decorates the
// output inside a labelled detail block, this prints the tail verbatim so it
// can be grepped/redirected without stripping the surrounding chrome.
// Pure functions here (separate from the commander wiring in cli.ts) so the
// output is unit-testable without a store, a TTY, or a spawned process.

import type { RelayJob } from "@agentrelay/core";

export interface TailOptions {
  /** Keep only the last N lines of the captured tail. Omit/≤0 for the whole tail. */
  lines?: number;
}

/**
 * Take the last `n` lines of a captured output tail. Pure and forgiving: a
 * nullish/empty tail yields an empty string, an absent/non-positive `n` returns
 * the tail unchanged, and both `\n` and `\r\n` line endings are honoured while
 * the original endings are preserved in the returned slice.
 */
export function lastLines(tail: string | null | undefined, n?: number): string {
  if (!tail) return "";
  if (n === undefined || n <= 0) return tail;
  // Split on newlines but keep the original text so we can return an exact
  // suffix (no re-joining that would normalise \r\n -> \n or drop a trailing
  // newline). Count line breaks from the end until we've kept `n` lines.
  const normalized = tail.endsWith("\n") ? tail.slice(0, -1) : tail;
  const lineCount = normalized.split("\n").length;
  if (lineCount <= n) return tail;
  // Find the index just after the (lineCount - n)-th newline in the ORIGINAL
  // string so \r\n and the trailing newline survive intact.
  let cut = 0;
  let seen = 0;
  const skip = lineCount - n;
  for (let i = 0; i < tail.length && seen < skip; i++) {
    if (tail[i] === "\n") {
      seen++;
      cut = i + 1;
    }
  }
  return tail.slice(cut);
}

/**
 * Render the raw output tail for `agentrelay tail`. Returns the tail (optionally
 * limited to the last N lines) with no decoration. When the job has no captured
 * output, returns an empty string so stdout stays clean (the CLI notes the
 * absence on stderr instead).
 */
export function renderTail(job: RelayJob, options: TailOptions = {}): string {
  return lastLines(job.lastOutputTail, options.lines);
}

/**
 * Machine-readable tail for `--json`: the resolved id plus the (line-limited)
 * tail and a boolean for whether anything was captured, so scripts don't have
 * to distinguish `""` from "no capture".
 */
export function renderTailJson(
  job: RelayJob,
  options: TailOptions = {},
  generatedAt: string = new Date().toISOString()
): string {
  const tail = lastLines(job.lastOutputTail, options.lines);
  return JSON.stringify(
    {
      generatedAt,
      id: job.id,
      hasOutput: job.lastOutputTail != null && job.lastOutputTail.length > 0,
      tail,
    },
    null,
    2
  );
}
