// Format selection for `agentrelay export`. The actual serialization lives in
// @agentrelay/core (`jobsToCsv`/`jobsToJson`); this thin layer just validates
// the requested format and dispatches, kept pure and separate from the
// commander wiring / file writing in cli.ts + commands.ts.

import { jobsToCsv, jobsToJson, type RelayJob } from "@agentrelay/core";

/** Output formats `agentrelay export --format` accepts. */
export const EXPORT_FORMATS = ["csv", "json"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Type guard so the CLI can reject an unknown `--format` value with a clear error. */
export function isExportFormat(value: string): value is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(value);
}

/** Serialize the (already filtered/sorted) jobs into the requested format. */
export function renderExport(jobs: RelayJob[], format: ExportFormat): string {
  return format === "json" ? jobsToJson(jobs) : jobsToCsv(jobs);
}
