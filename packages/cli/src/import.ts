// Machine-readable rendering for `agentrelay import --json`. Where the default
// import output is human prose on stderr (counts + one line per rejected
// record), `--json` emits a single structured object on stdout so a CI or
// migration wrapper can verify an import programmatically — assert the counts,
// surface every parse error, and branch on `dryRun` — without scraping text.
// Kept as a pure function (separate from the commander wiring) so the shape is
// testable without a store, a clock, or a spawned process, matching how the
// other `--json` renderers (`next`, `summary`, `show`, …) are structured.

import type { ImportParseError, ImportResult } from "@agentrelay/core";

/** The import outcome the JSON view serializes: the merge counts plus the
 *  per-record parse errors and whether the store was left untouched. */
export interface ImportJsonInput extends ImportResult {
  /** Records that failed structural validation (skipped), in source order. */
  parseErrors: ImportParseError[];
  /** True when nothing was written (a `--dry-run` preview). */
  dryRun: boolean;
}

/**
 * Serialize an import outcome as pretty JSON. Mirrors the other `--json`
 * commands' envelope (`storePath` + `generatedAt`) so scripts see a consistent
 * shape, then carries the full merge breakdown: `dryRun`, the four merge counts
 * (`added`/`updated`/`skippedExisting`/`skippedActive`), and the `parseErrors`
 * array verbatim (each `{ kind, index, reason }`) so a malformed dump is
 * diagnosable from the JSON alone. Pure: the timestamp is injectable for tests.
 */
export function renderImportJson(
  result: ImportJsonInput,
  storePath: string,
  generatedAt: string = new Date().toISOString()
): string {
  return JSON.stringify(
    {
      storePath,
      generatedAt,
      dryRun: result.dryRun,
      added: result.added,
      updated: result.updated,
      skippedExisting: result.skippedExisting,
      skippedActive: result.skippedActive,
      parseErrors: result.parseErrors,
    },
    null,
    2
  );
}
