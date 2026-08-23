import { basename } from "node:path";
import type { CleanSidecarsResult } from "./commands.js";

/**
 * Render for `agentrelay clean` — the human-readable report of which store
 * sidecar files (`.corrupt-*` recovery copies, stranded `.tmp-*` write temps)
 * were removed (or, in dry-run, would be). Pure: takes an already-computed
 * result, returns lines, touches no filesystem.
 */

/** Compact byte size, e.g. `512 B`, `3.2 KB`, `1.4 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function renderCleanResult(result: CleanSidecarsResult): string {
  if (result.dirUnreadable) {
    return "Store directory not found — nothing to clean.";
  }
  const verb = result.dryRun ? "Would remove" : "Removed";
  if (result.removed.length === 0) {
    return "No sidecar files to clean.";
  }
  const lines: string[] = [];
  for (const entry of result.removed) {
    const mark = result.dryRun ? "-" : "×";
    lines.push(`${mark} [${entry.kind}] ${basename(entry.path)}  (${formatBytes(entry.sizeBytes)})`);
  }
  lines.push(`${verb} ${result.removed.length} file(s), ${formatBytes(result.freedBytes)} freed.`);
  return lines.join("\n");
}

export function renderCleanResultJson(result: CleanSidecarsResult): string {
  return JSON.stringify(
    {
      dryRun: result.dryRun,
      dirUnreadable: result.dirUnreadable,
      removedCount: result.removed.length,
      freedBytes: result.freedBytes,
      removed: result.removed.map((e) => ({ path: e.path, kind: e.kind, sizeBytes: e.sizeBytes })),
    },
    null,
    2
  );
}
