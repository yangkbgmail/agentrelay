// Housekeeping for the store *directory* — the leftover files that no other
// command manages.
//
// `prune` trims finished jobs out of `jobs.json`, and `backup --keep` rotates
// the `.backup-*` snapshots. But two other kinds of file accumulate next to the
// store with nothing to ever remove them:
//
//   - `jobs.json.corrupt-<ts>` — a recovery copy the queue moves aside whenever
//     it finds an unparseable store (see `corruptBackupPath` in queue.ts). One
//     is written every time corruption is recovered, and they live forever.
//   - `jobs.json.tmp-<pid>-<ms>` / `jobs.json.tmp-backup-<pid>-<ms>` — the temp
//     file of an atomic write. Normally renamed into place immediately, but a
//     process killed mid-flush leaves an orphan behind.
//
// `agentrelay clean` removes these. As with backup.ts, this module holds only
// pure helpers (classification + selection) so they're trivially testable; the
// actual filesystem deletes live on `RelayQueue.clean()`.

import { BACKUP_INFIX } from "./backup.js";

/**
 * Filename infix marking a corruption-recovery copy, e.g.
 * `jobs.json.corrupt-<ts>` (written by `corruptBackupPath` in queue.ts).
 */
export const CORRUPT_INFIX = ".corrupt-";

/**
 * Filename infix marking an atomic-write temp file, e.g.
 * `jobs.json.tmp-<pid>-<ms>` (store flush) or `jobs.json.tmp-backup-<pid>-<ms>`
 * (snapshot write). Both share this prefix, so one check catches both.
 */
export const TMP_INFIX = ".tmp-";

/** How a directory basename relates to the store file it sits next to. */
export type StoreFileKind = "store" | "backup" | "corrupt" | "tmp" | "other";

/**
 * The sortable timestamp portion of `fileName` if it is a corruption-recovery
 * copy of `storeFileName` (both plain basenames), else null. Parallels
 * {@link backupStamp}: the `.corrupt-` infix is followed by the same
 * filesystem-safe ISO stamp (`:`/`.` → `-`), so lexical order == chronological.
 */
export function corruptStamp(fileName: string, storeFileName: string): string | null {
  const prefix = `${storeFileName}${CORRUPT_INFIX}`;
  if (!fileName.startsWith(prefix)) return null;
  const stamp = fileName.slice(prefix.length);
  return stamp.length > 0 ? stamp : null;
}

/**
 * Classifies a directory basename relative to `storeFileName`. `.backup-*` is
 * checked before `.corrupt-*`/`.tmp-*`, but the infixes are disjoint so the
 * order is only for clarity. A `.tmp-backup-*` file starts with `.tmp-` (not
 * `.backup-`), so it classifies as `tmp` — the write-in-flight file, not a
 * finished snapshot. Anything unrelated is `other` and never touched.
 */
export function classifyStoreFile(fileName: string, storeFileName: string): StoreFileKind {
  if (fileName === storeFileName) return "store";
  if (fileName.startsWith(`${storeFileName}${BACKUP_INFIX}`)) return "backup";
  if (corruptStamp(fileName, storeFileName) !== null) return "corrupt";
  const tmpPrefix = `${storeFileName}${TMP_INFIX}`;
  if (fileName.startsWith(tmpPrefix) && fileName.length > tmpPrefix.length) return "tmp";
  return "other";
}

/** A corruption-recovery copy and its sortable stamp. */
export interface CorruptEntry {
  /** The file's basename. */
  name: string;
  /** Its sortable timestamp infix (see {@link corruptStamp}). */
  stamp: string;
}

/**
 * The store's corruption-recovery copies among `fileNames` (basenames, any
 * order), sorted newest first — lexical-descending on the stamp is
 * chronological-descending. Non-corrupt files are dropped.
 */
export function listCorruptBackups(fileNames: string[], storeFileName: string): CorruptEntry[] {
  const entries: CorruptEntry[] = [];
  for (const name of fileNames) {
    const stamp = corruptStamp(name, storeFileName);
    if (stamp !== null) entries.push({ name, stamp });
  }
  return entries.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
}

/**
 * The store's leftover atomic-write temp files among `fileNames`, sorted by
 * name for deterministic output. Temp names embed `<pid>-<ms>` rather than a
 * sortable ISO stamp, so there's no meaningful chronological order to expose —
 * they're all equally removable.
 */
export function listTmpFiles(fileNames: string[], storeFileName: string): string[] {
  return fileNames.filter((name) => classifyStoreFile(name, storeFileName) === "tmp").sort();
}

/** Options controlling what {@link selectCleanableFiles} selects for removal. */
export interface CleanOptions {
  /**
   * Retain the newest N corruption-recovery copies (default 0 = remove all).
   * Mirrors `backup --keep`: a user may want to keep the most recent corruption
   * around to inspect while still clearing the older accumulation.
   */
  keepCorrupt?: number;
  /**
   * Also select leftover `.tmp-*` temp files (default false). Off by default
   * because a temp file *could* belong to a daemon's in-flight atomic write;
   * the caller opts in once no writer is running.
   */
  includeTmp?: boolean;
}

/** The files {@link selectCleanableFiles} chose, split by kind. */
export interface CleanSelection {
  /** Basenames of corruption-recovery copies to remove (past the newest kept). */
  corrupt: string[];
  /** Basenames of leftover temp files to remove (empty unless `includeTmp`). */
  tmp: string[];
}

/**
 * Given a directory listing (basenames, any order) and options, the store files
 * that should be removed — corruption-recovery copies past the newest
 * `keepCorrupt`, plus leftover temp files when `includeTmp`. Never selects the
 * live store or its `.backup-*` snapshots. Pure: returns names, deletes nothing.
 */
export function selectCleanableFiles(
  fileNames: string[],
  storeFileName: string,
  options: CleanOptions = {}
): CleanSelection {
  const keepCorrupt = Math.max(0, Math.floor(options.keepCorrupt ?? 0));
  const corrupt = listCorruptBackups(fileNames, storeFileName)
    .slice(keepCorrupt)
    .map((e) => e.name);
  const tmp = options.includeTmp ? listTmpFiles(fileNames, storeFileName) : [];
  return { corrupt, tmp };
}

/** Outcome of {@link RelayQueue.clean}. */
export interface CleanResult {
  /** Absolute paths of corruption-recovery copies selected for removal. */
  corrupt: string[];
  /** Absolute paths of leftover temp files selected for removal. */
  tmp: string[];
  /** Absolute paths actually deleted (empty on a dry run). */
  removed: string[];
  /** Absolute paths that were selected but could not be deleted. */
  failed: string[];
  /** How many newest corruption-recovery copies were retained. */
  keptCorrupt: number;
  /** Whether this was a preview (nothing deleted). */
  dryRun: boolean;
}
