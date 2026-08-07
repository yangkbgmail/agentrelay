// Rotating snapshots of the JSON store. The store file (`jobs.json`) is the
// single source of truth for a local-first relay, so a way to take a
// point-in-time snapshot before a risky operation (a large `prune`, a manual
// edit, an upgrade) — and to keep only the newest N so they don't accumulate —
// is a natural safety companion to the corrupt-file recovery in queue.ts.
//
// This module holds only pure helpers (path naming + rotation selection) so
// they're trivially testable; the actual filesystem writes live on
// `RelayQueue.backup()`.

import { parseDuration } from "./prune.js";

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

/**
 * Resolves which of the store's snapshots a restore `selector` refers to,
 * returning the matched {@link BackupEntry} or null when nothing matches.
 * `selector` may be:
 *   - `"latest"` (or empty) → the newest snapshot;
 *   - a snapshot basename (e.g. `jobs.json.backup-2026-...Z`);
 *   - the sortable stamp portion alone (e.g. `2026-07-18T09-00-01-000Z`).
 * `fileNames` are directory basenames (any order); only this store's snapshots
 * are considered. Pure: reads nothing, deletes nothing.
 */
export function resolveBackup(fileNames: string[], storeFileName: string, selector: string): BackupEntry | null {
  const backups = listBackups(fileNames, storeFileName); // newest first
  if (backups.length === 0) return null;
  if (selector === "" || selector === "latest") return backups[0];
  return backups.find((b) => b.name === selector) ?? backups.find((b) => b.stamp === selector) ?? null;
}

/** Outcome of {@link RelayQueue.restore}. */
export interface RestoreResult {
  /** Absolute path of the snapshot the store was restored from. */
  from: string;
  /** Number of jobs in the restored store. */
  jobCount: number;
  /**
   * Where the pre-restore store was snapshotted for safety, or null when the
   * safety backup was skipped or there was no existing store to snapshot.
   */
  backedUpTo: string | null;
}

/**
 * Outcome of a dry-run restore preview (see {@link RelayQueue.previewRestore}):
 * what a real restore *would* do, without touching the live store. The snapshot
 * is still validated, so a broken snapshot is reported in the preview too.
 */
export interface RestorePreview {
  /** Absolute path of the snapshot that would be restored from. */
  from: string;
  /** Number of jobs the snapshot holds — what the store would become. */
  jobCount: number;
  /** Number of jobs currently in the store — what the restore would replace. */
  currentJobCount: number;
  /**
   * Whether a real restore would first snapshot the current store for safety
   * (true only when a safety backup is requested *and* a store file exists).
   */
  wouldBackUp: boolean;
}

/**
 * Configuration for the daemon's periodic auto-backup — snapshotting the JSON
 * store on a schedule without a separate cron, the safety companion to
 * auto-prune (which trims history). A backup pass runs before the tick's
 * auto-prune, so each snapshot still holds the finished jobs a prune is about
 * to remove.
 */
export interface AutoBackupOptions {
  /** Retain the newest N snapshots after each pass (rotation, like `backup`). */
  keepLast: number;
  /** Minimum wall-clock interval (ms) between auto-backup passes. Always > 0. */
  everyMs: number;
}

/**
 * Default interval between auto-backup passes when the daemon opts in without an
 * explicit `AGENTRELAY_AUTOBACKUP_EVERY`. One hour keeps a useful set of recent
 * snapshots without rewriting the store on every fast poll — unlike auto-prune,
 * an auto-backup *always* carries a positive interval, because snapshotting on
 * every tick would spew files pointlessly.
 */
export const DEFAULT_AUTOBACKUP_EVERY_MS = 60 * 60_000;

function parseAutoBackupBool(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Builds the {@link AutoBackupOptions} the daemon should apply, from environment
 * variables — or `null` when auto-backup is off (the default). Lets a
 * long-running daemon keep timestamped snapshots of the single JSON data file
 * without a separate `agentrelay backup` cron:
 *
 * - `AGENTRELAY_AUTOBACKUP`        opt-in flag (1/true/yes/on). Off ⇒ returns null.
 * - `AGENTRELAY_AUTOBACKUP_EVERY`  interval like `1h`/`30m`/`6h` (default 1h).
 *                                  Missing, unparseable, or non-positive values
 *                                  fall back to the 1h default rather than
 *                                  disabling the opt-in or backing up every tick.
 * - `AGENTRELAY_AUTOBACKUP_KEEP`   retain the newest N snapshots (default
 *                                  {@link DEFAULT_BACKUP_KEEP}); `0` keeps only
 *                                  the pass's own fresh snapshot.
 */
export function autoBackupOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): AutoBackupOptions | null {
  if (!parseAutoBackupBool(env.AGENTRELAY_AUTOBACKUP)) return null;

  let everyMs = DEFAULT_AUTOBACKUP_EVERY_MS;
  const everyRaw = env.AGENTRELAY_AUTOBACKUP_EVERY?.trim();
  if (everyRaw) {
    const parsed = parseDuration(everyRaw);
    if (parsed !== null && parsed > 0) everyMs = parsed;
  }

  let keepLast = DEFAULT_BACKUP_KEEP;
  const keepRaw = env.AGENTRELAY_AUTOBACKUP_KEEP?.trim();
  if (keepRaw) {
    const n = Number(keepRaw);
    if (Number.isFinite(n) && n >= 0) keepLast = Math.floor(n);
  }

  return { keepLast, everyMs };
}

/**
 * Pure predicate deciding whether an auto-backup pass should run now, given the
 * timestamp of the last pass (`lastRunMs`, or `null` if none yet), the current
 * time (`nowMs`), and the configured interval (`everyMs`). Mirrors
 * {@link shouldAutoPrune}: the first pass (`lastRunMs === null`) always runs so a
 * snapshot is captured at daemon start; afterwards a pass runs only once
 * `everyMs` has elapsed. An `everyMs` of `0`/undefined means "no throttle" (run
 * every tick) for symmetry, though {@link autoBackupOptionsFromEnv} never
 * produces one.
 */
export function shouldAutoBackup(lastRunMs: number | null, nowMs: number, everyMs?: number): boolean {
  if (!everyMs || everyMs <= 0) return true;
  if (lastRunMs === null) return true;
  return nowMs - lastRunMs >= everyMs;
}
