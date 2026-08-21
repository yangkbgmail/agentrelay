/**
 * Store-file permission hardening.
 *
 * The job store (`jobs.json`), its backups, and its temp files all contain each
 * job's full `command` array — the exact argv the relay will re-spawn. That argv
 * frequently carries sensitive material: an `--api-key sk-…` flag, a token in a
 * URL, a `-p "…"` prompt with private context. On a multi-user machine a
 * world-readable store leaks all of that to anyone with a shell.
 *
 * Well-behaved local tools (ssh, gpg, npm) fix this by writing their private
 * files with owner-only permissions instead of leaving the mode to the
 * process umask (which is commonly `022`, i.e. group/other *readable*). We do
 * the same: every store write is chmod'd to {@link DEFAULT_STORE_FILE_MODE}
 * (`0600`) so the file is readable and writable by its owner alone.
 *
 * This module is the *pure* policy layer — it decides what mode to apply and how
 * to parse a user override. The one filesystem touch, {@link applyFileMode}, is
 * deliberately best-effort and never throws, so a platform that can't chmod
 * (e.g. a Windows/FAT mount) degrades to "no hardening" rather than breaking the
 * relay loop.
 */
import { chmodSync } from "node:fs";

/**
 * Default mode for store files: `0o600` (owner read/write, no group/other
 * access). Chosen to protect the command lines the store persists.
 */
export const DEFAULT_STORE_FILE_MODE = 0o600;

/** The largest value a POSIX permission triple can hold (`rwxrwxrwx`). */
const MAX_FILE_MODE = 0o777;

/**
 * Parse a user-supplied file-mode string into a permission number, or `null`
 * when it isn't a valid mode. Accepts the octal spellings people actually type:
 * `"600"`, `"0600"`, `"0o600"`, `"640"`. The value is always interpreted as
 * **octal** (like `chmod`), never decimal, and must land in `0..0o777`.
 *
 * Pure and side-effect free.
 */
export function parseFileMode(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  // Strip an optional `0o`/`0O` or bare leading-zero octal prefix, then require
  // the remainder to be octal digits only (0-7). This rejects decimal-looking
  // "8"/"9" and any non-digit noise rather than silently mis-parsing them.
  const body = trimmed.replace(/^0o/i, "");
  if (!/^[0-7]+$/.test(body)) return null;
  const mode = Number.parseInt(body, 8);
  if (!Number.isInteger(mode) || mode < 0 || mode > MAX_FILE_MODE) return null;
  return mode;
}

/**
 * Resolve the store file mode from `AGENTRELAY_STORE_MODE`:
 *
 * - unset / empty → {@link DEFAULT_STORE_FILE_MODE} (`0600`).
 * - `off` / `none` / `inherit` / `default` (case-insensitive) → `null`, meaning
 *   "don't chmod at all" — the file keeps whatever mode the umask gives it. This
 *   is the opt-out for users who deliberately want a group-readable store (e.g.
 *   a shared service account).
 * - a valid octal mode (`640`, `0600`, …) → that mode.
 * - anything else (a typo, an out-of-range value) → {@link DEFAULT_STORE_FILE_MODE}.
 *   A malformed override must **never silently loosen** the store's permissions,
 *   so we fall back to the secure default rather than to "no hardening".
 */
export function storeFileModeFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.AGENTRELAY_STORE_MODE?.trim();
  if (raw === undefined || raw === "") return DEFAULT_STORE_FILE_MODE;
  if (/^(off|none|inherit|default)$/i.test(raw)) return null;
  return parseFileMode(raw) ?? DEFAULT_STORE_FILE_MODE;
}

/**
 * Best-effort `chmod` of `path` to `mode`. A `null` mode is a no-op ("don't
 * touch permissions"). Any failure — an unsupported filesystem, a Windows mount
 * that can't represent POSIX bits, a race where the file vanished — is swallowed:
 * tightening permissions must never be able to break a store write or crash the
 * relay loop. Returns `true` when the chmod was applied, `false` otherwise.
 */
export function applyFileMode(path: string, mode: number | null): boolean {
  if (mode === null) return false;
  try {
    chmodSync(path, mode);
    return true;
  } catch {
    return false;
  }
}
