// Housekeeping for the store's sidecar files. The JSON store (`jobs.json`) is
// the single source of truth, but two kinds of *sidecar* files accumulate next
// to it and nothing ever removes them:
//
//   - `.corrupt-<ts>`  — a recovery copy `RelayQueue.load()` makes when it finds
//     the store unparseable (so a corrupt file is preserved, not silently
//     overwritten). See `corruptBackupPath` in queue.ts.
//   - `.tmp-<pid>-<ms>` / `.tmp-backup-<pid>-<ms>` — the temp file every atomic
//     write goes through (write temp → rename over the real file). A normal
//     write renames it away, but a crash *mid-write* (power loss, OOM kill, a
//     full disk) can strand one on disk forever.
//
// `backup --keep N` rotates only `.backup-*` snapshots, and `prune` only removes
// terminal *jobs* from inside the store — neither touches these. Over a long-
// lived install they just pile up (and a stranded `.tmp-*` from a failed write
// on a full disk is exactly when freeing space matters most). This module is
// the *pure* half of `agentrelay clean`: given a directory listing plus each
// file's age, it decides which sidecars are removable. The filesystem I/O
// (readdir / stat / unlink) lives in the CLI, mirroring how backup/prune split
// pure selection from side effects.

/**
 * Filename infix marking a corrupt-store recovery copy, e.g.
 * `jobs.json.corrupt-2026-08-23T04-00-00-000Z`. Kept in sync with
 * `corruptBackupPath` in queue.ts (a unit test asserts a path it produces
 * classifies as `"corrupt"`, so a drift breaks loudly).
 */
export const CORRUPT_INFIX = ".corrupt-";

/**
 * Filename infix marking an atomic-write temp file, e.g.
 * `jobs.json.tmp-12345-1750000000000` or `jobs.json.tmp-backup-12345-…`. Kept in
 * sync with the temp names written in queue.ts (`.tmp-` prefix covers both the
 * plain flush temp and the `.tmp-backup-` snapshot temp).
 */
export const TMP_INFIX = ".tmp-";

/** Which kind of store sidecar a file is. */
export type SidecarKind = "corrupt" | "tmp";

/** The sidecar kinds `clean` manages, in a stable order. */
export const SIDECAR_KINDS: readonly SidecarKind[] = ["corrupt", "tmp"] as const;

/** True if `value` names a sidecar kind (for validating a `--kind` flag). */
export function isSidecarKind(value: string): value is SidecarKind {
  return (SIDECAR_KINDS as readonly string[]).includes(value);
}

/**
 * Classify `fileName` (a basename) relative to the store's basename
 * `storeFileName`. Returns the sidecar kind, or `null` if it isn't one of this
 * store's removable sidecars — including the store file itself and its
 * `.backup-*` snapshots (which have their own rotation and must never be swept
 * here). A trailing character after the infix is required so a bare
 * `jobs.json.corrupt-` with no stamp isn't matched. Pure.
 */
export function classifySidecar(fileName: string, storeFileName: string): SidecarKind | null {
  const corruptPrefix = `${storeFileName}${CORRUPT_INFIX}`;
  if (fileName.startsWith(corruptPrefix) && fileName.length > corruptPrefix.length) return "corrupt";
  const tmpPrefix = `${storeFileName}${TMP_INFIX}`;
  if (fileName.startsWith(tmpPrefix) && fileName.length > tmpPrefix.length) return "tmp";
  return null;
}

/** One sidecar file, as gathered by the CLI from the store's directory. */
export interface SidecarFile {
  /** The file's basename. */
  name: string;
  /** Which sidecar kind it is. */
  kind: SidecarKind;
  /** Last-modified time, epoch ms (from `stat`). */
  mtimeMs: number;
  /** Size in bytes (from `stat`), for a "freed N bytes" report. */
  sizeBytes: number;
}

export interface CleanSelectOptions {
  /** Reference "now", epoch ms, for the age comparison. */
  nowMs: number;
  /**
   * Only remove sidecars older than this many ms (by `mtimeMs`) before
   * {@link nowMs}. `null`/`undefined`/`<= 0` disables the age filter, so every
   * kind-eligible sidecar is a candidate.
   */
  olderThanMs?: number | null;
  /**
   * Restrict to these sidecar kinds. Defaults to {@link SIDECAR_KINDS} (all).
   * An empty array selects nothing.
   */
  kinds?: readonly SidecarKind[];
}

/**
 * Pure, side-effect-free selection of the sidecar files a clean would remove,
 * applying the kind and age filters. Returned oldest-first (stable name-ordered
 * tiebreak) so output and any partial deletion are deterministic.
 */
export function selectCleanableSidecars(files: SidecarFile[], options: CleanSelectOptions): SidecarFile[] {
  const kinds = options.kinds ?? SIDECAR_KINDS;
  const kindSet = new Set(kinds);
  const cutoff =
    options.olderThanMs != null && Number.isFinite(options.olderThanMs) && options.olderThanMs > 0
      ? options.nowMs - options.olderThanMs
      : null;

  const selected = files.filter((f) => {
    if (!kindSet.has(f.kind)) return false;
    if (cutoff !== null && f.mtimeMs > cutoff) return false;
    return true;
  });

  return selected.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
