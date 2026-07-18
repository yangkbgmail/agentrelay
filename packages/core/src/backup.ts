/**
 * How many store backups to retain by default when rotating. Old backups beyond
 * this count (oldest first) are removed so `agentrelay backup` can be run
 * repeatedly (e.g. from cron) without the backup files growing unbounded.
 */
export const DEFAULT_BACKUP_KEEP = 10;

/** Infix that marks a file as a store backup: `<store-basename>.bak-<stamp>`. */
const BAK_INFIX = ".bak-";

/**
 * Filesystem-safe timestamp suffix (the ISO string's `:` and `.` replaced with
 * `-`), matching the convention used for corrupt-store backups so both kinds of
 * sidecar file sort and read the same way. Fixed-width and year-first, so a
 * plain lexicographic sort of these stamps is chronological.
 */
export function backupStamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * Path of a fresh backup for `storePath`: a sibling named
 * `<store-basename>.bak-<stamp>` living next to the store itself. Takes an
 * explicit `now` for deterministic tests. The `.bak-` infix is distinct from
 * the `.corrupt-` and `.tmp-` sidecars the queue writes, so rotation never
 * touches those.
 */
export function backupPathFor(storePath: string, now: Date = new Date()): string {
  return `${storePath}${BAK_INFIX}${backupStamp(now)}`;
}

/**
 * True when `fileName` (a bare basename) is a backup of a store whose basename
 * is `storeBase` — i.e. `<storeBase>.bak-<something>` with a non-empty stamp.
 */
export function isBackupFile(fileName: string, storeBase: string): boolean {
  const prefix = `${storeBase}${BAK_INFIX}`;
  return fileName.startsWith(prefix) && fileName.length > prefix.length;
}

/**
 * Given every entry (bare basenames) in the store's directory and the store's
 * own basename, returns the backup basenames to delete so that only the newest
 * `keepLast` survive. Backups sort chronologically by their fixed-width stamp,
 * so a plain ascending string sort puts the oldest first. `keepLast <= 0`
 * selects *every* backup (keep none); the CLI guards against that so a freshly
 * written backup is never immediately rotated away. Pure and non-mutating.
 */
export function selectRotatedBackups(entries: string[], storeBase: string, keepLast: number): string[] {
  const backups = entries.filter((name) => isBackupFile(name, storeBase)).sort();
  if (keepLast <= 0) return backups;
  if (backups.length <= keepLast) return [];
  return backups.slice(0, backups.length - keepLast);
}
