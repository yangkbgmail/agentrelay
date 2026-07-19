// Rotating snapshots of the JSON store. The store file (`jobs.json`) is the
// single source of truth for a local-first relay, so a way to take a
// point-in-time snapshot before a risky operation (a large `prune`, a manual
// edit, an upgrade) — and to keep only the newest N so they don't accumulate —
// is a natural safety companion to the corrupt-file recovery in queue.ts.
//
// This module holds only pure helpers (path naming + rotation selection) so
// they're trivially testable; the actual filesystem writes live on
// `RelayQueue.backup()`.

/**
 * Filename infix marking a rotating store snapshot, e.g.
 * `jobs.json.backup-<ts>`. Deliberately distinct from the `.corrupt-` (recovery)
 * and `.tmp-` (atomic-write) infixes so rotation only ever matches — and
 * deletes — real snapshots, never a recovery copy or an in-flight temp file.
 */
export const BACKUP_INFIX = ".backup-";

/** Default number of snapshots to retain when a caller doesn't specify. */
export const DEFAULT_BACKUP_KEEP = 10;

/**
 * Path of a timestamped store snapshot next to the store file, e.g.
 * `jobs.json.backup-2026-07-18T13-38-10-351Z`. The ISO timestamp's `:`/`.` are
 * replaced with `-` so the name is filesystem-safe and, because ISO 8601 is
 * fixed-width and zero-padded, lexically sortable == chronologically sortable.
 * `now` is injectable for deterministic tests.
 */
export function backupFilePath(storePath: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${storePath}${BACKUP_INFIX}${stamp}`;
}

/**
 * The sortable timestamp portion of `fileName` if it is a backup of
 * `storeFileName` (both plain basenames), else null. Used to filter a directory
 * listing down to one store's snapshots and to order them.
 */
export function backupStamp(fileName: string, storeFileName: string): string | null {
  const prefix = `${storeFileName}${BACKUP_INFIX}`;
  if (!fileName.startsWith(prefix)) return null;
  const stamp = fileName.slice(prefix.length);
  return stamp.length > 0 ? stamp : null;
}

export interface BackupEntry {
  /** The backup file's basename. */
  name: string;
  /** Its sortable timestamp infix (see {@link backupStamp}). */
  stamp: string;
}

/**
 * The store's backups among `fileNames` (basenames, any order), sorted newest
 * first — lexical-descending on the stamp is chronological-descending. Files
 * that aren't this store's snapshots are dropped.
 */
export function listBackups(fileNames: string[], storeFileName: string): BackupEntry[] {
  const entries: BackupEntry[] = [];
  for (const name of fileNames) {
    const stamp = backupStamp(name, storeFileName);
    if (stamp !== null) entries.push({ name, stamp });
  }
  return entries.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
}

/**
 * Given the store's backups (basenames, any order) and how many newest to keep,
 * the names to delete — everything past the newest `keepLast`. `keepLast <= 0`
 * selects every backup for deletion (callers that just wrote a fresh snapshot
 * are expected to spare it themselves). Non-integers are floored. Pure: returns
 * names, deletes nothing.
 */
export function selectRotatableBackups(fileNames: string[], storeFileName: string, keepLast: number): string[] {
  const ordered = listBackups(fileNames, storeFileName);
  const keep = Math.max(0, Math.floor(keepLast));
  return ordered.slice(keep).map((e) => e.name);
}

/** Outcome of {@link RelayQueue.backup}. */
export interface BackupResult {
  /** Absolute path of the snapshot just written. */
  path: string;
  /** Number of jobs captured in the snapshot. */
  jobCount: number;
  /** Backup files removed by rotation (may be empty). */
  rotated: string[];
}
