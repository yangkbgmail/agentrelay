import { basename, dirname } from "node:path";
import { BACKUP_INFIX, backupStamp } from "./backup.js";
import { daemonHeartbeatPath } from "./heartbeat.js";

/**
 * `agentrelay paths` — a plain "where does AgentRelay keep my stuff?" report.
 *
 * The other diagnostics have gaps here: `config show` prints the *effective
 * settings* (and secrets), `doctor` *judges health* (is the store corrupt, is a
 * resume loop alive), but neither simply answers "which files on disk does this
 * tool read and write, and do they exist yet?". When a job silently isn't
 * resuming, the very first question is usually "am I even looking at the right
 * store?" — especially once `AGENTRELAY_STORE`, a project-local config, and a
 * per-user config can all point somewhere different.
 *
 * This module is the *pure* half: given already-gathered facts (the resolved
 * store/config paths and what exists on disk), it composes the structured
 * report. The filesystem probing and clock live in the CLI, mirroring how
 * `doctor` and the heartbeat split pure logic from I/O.
 */

/** Which AgentRelay filesystem location an entry describes. */
export type LocationKind = "store" | "store-dir" | "config" | "heartbeat" | "backups";

/** One filesystem location AgentRelay uses, with whether it currently exists. */
export interface LocationEntry {
  kind: LocationKind;
  /** Human-readable label, e.g. "Job store". */
  label: string;
  /**
   * Absolute path (or a `…/jobs.json.backup-*` glob for the backups entry), or
   * `null` when the location does not apply — e.g. no config file was resolved.
   */
  path: string | null;
  /** Whether the path currently exists on disk (for backups: at least one snapshot). */
  exists: boolean;
  /** Short note explaining an absent/derived location, e.g. "created on first run". */
  note?: string;
}

/** The full `agentrelay paths` report: the store it is about, plus one entry per location. */
export interface LocationReport {
  storePath: string;
  entries: LocationEntry[];
}

/**
 * Filesystem facts the CLI gathers before calling {@link buildLocationReport}.
 * Kept as plain data so the report logic stays pure and testable without touching
 * disk.
 */
export interface LocationFacts {
  /** The effective job store path (after `--store`/`AGENTRELAY_STORE`/config/default). */
  storePath: string;
  /** Whether the store file itself exists. */
  storeExists: boolean;
  /** Resolved config file path, or `null` when none was discovered. */
  configPath: string | null;
  /** Whether the resolved config file exists (meaningful only when `configPath` is set). */
  configExists: boolean;
  /** Whether the daemon heartbeat file exists. */
  heartbeatExists: boolean;
  /**
   * File names in the store directory, or `null` when the directory does not
   * exist / can't be read. Used to count `.backup-*` snapshots without the pure
   * layer touching the filesystem.
   */
  storeDirFiles: string[] | null;
}

/** Count `<store>.backup-*` snapshots among a directory listing. Pure. */
export function countStoreBackups(storeFileName: string, dirFiles: string[] | null): number {
  if (!dirFiles) return 0;
  let count = 0;
  for (const name of dirFiles) {
    if (backupStamp(name, storeFileName) !== null) count += 1;
  }
  return count;
}

/**
 * Compose the {@link LocationReport} from gathered {@link LocationFacts}. Pure:
 * derives the store directory, heartbeat, and backups-glob paths from the store
 * path and reports existence, with a helpful note whenever a location is absent.
 */
export function buildLocationReport(facts: LocationFacts): LocationReport {
  const storeDir = dirname(facts.storePath);
  const storeFileName = basename(facts.storePath);
  const storeDirExists = facts.storeDirFiles !== null;
  const backupCount = countStoreBackups(storeFileName, facts.storeDirFiles);

  const entries: LocationEntry[] = [
    {
      kind: "store",
      label: "Job store",
      path: facts.storePath,
      exists: facts.storeExists,
      note: facts.storeExists ? undefined : "not found — created on first run",
    },
    {
      kind: "store-dir",
      label: "Store directory",
      path: storeDir,
      exists: storeDirExists,
      note: storeDirExists ? undefined : "not found — created on first run",
    },
    {
      kind: "config",
      label: "Config file",
      path: facts.configPath,
      exists: facts.configPath ? facts.configExists : false,
      note: facts.configPath
        ? facts.configExists
          ? undefined
          : "resolved but missing"
        : "none found — using built-in defaults",
    },
    {
      kind: "heartbeat",
      label: "Daemon heartbeat",
      path: daemonHeartbeatPath(facts.storePath),
      exists: facts.heartbeatExists,
      note: facts.heartbeatExists ? undefined : "no resume loop has run yet",
    },
    {
      kind: "backups",
      label: "Store backups",
      path: `${facts.storePath}${BACKUP_INFIX}*`,
      exists: backupCount > 0,
      note: `${backupCount} snapshot${backupCount === 1 ? "" : "s"}`,
    },
  ];

  return { storePath: facts.storePath, entries };
}
