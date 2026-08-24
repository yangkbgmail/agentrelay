// Storage backend decision (see PROGRESS.md log for the full story):
//
// We originally reached for `better-sqlite3`, but its native addon needs
// node-gyp to download Node headers from nodejs.org at install time -- that
// network call is blocked in some sandboxed/offline build environments
// (including the one this project was originally built in). We then tried
// Node's built-in `node:sqlite`, which avoids the native-compile problem,
// but as of Node 22.x it's still marked "experimental" and is missing from
// `module.builtinModules`, which trips up Vite/vitest's built-in-module
// externalization and breaks `pnpm test` in a way that's awkward to work
// around reliably.
//
// For a local-first, single-user MVP, real SQL isn't a hard requirement --
// so we use a plain JSON file as the source of truth instead. Writes are
// atomic (write to a temp file, then rename) so a reader (e.g. the
// dashboard's API route, or a concurrent CLI invocation) never observes a
// half-written file. This has zero dependencies, zero native compilation,
// and works identically on every platform/Node version. If AgentRelay ever
// needs real concurrent multi-writer access or heavier querying, revisit
// with `node:sqlite` once it stabilizes, or `sql.js`.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type BackupResult,
  backupFilePath,
  DEFAULT_BACKUP_KEEP,
  type RestorePreview,
  type RestoreResult,
  selectRotatableBackups,
} from "./backup.js";
import { type ImportOptions, type ImportResult, planImport, summarizeImportPlan } from "./import.js";
import { type PruneOptions, selectPrunableJobs } from "./prune.js";
import { planStoreRedaction, type StoreRedactionPlan } from "./redact.js";
import type { CreateJobInput, JobStatus, RateLimitDetection, RelayJob } from "./types.js";

/** Details handed to {@link RelayQueueOptions.onCorrupt} when the store file
 *  existed but couldn't be parsed. */
export interface CorruptStoreInfo {
  /** The store path that was unreadable. */
  path: string;
  /** Where the unreadable file was moved for safekeeping, or `null` if it
   *  couldn't be moved aside (e.g. a rename failure). */
  backupPath: string | null;
  /** The parse error that triggered the recovery. */
  error: unknown;
}

export interface RelayQueueOptions {
  /**
   * Called when the backing file existed but couldn't be parsed as a jobs
   * array. By the time this fires the corrupt file has already been moved aside
   * (see `backupPath`) and the queue has started fresh, so the relay loop keeps
   * running. Lets callers surface a warning instead of silently losing data.
   */
  onCorrupt?: (info: CorruptStoreInfo) => void;
}

/**
 * Where a corrupt store file is moved aside before the queue starts fresh, so
 * the unreadable data is preserved for inspection/recovery instead of being
 * silently clobbered by the next write. The suffix is filesystem-safe (the
 * ISO timestamp's `:`/`.` are replaced with `-`). Takes an explicit `now` for
 * deterministic tests.
 */
export function corruptBackupPath(filePath: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${filePath}.corrupt-${stamp}`;
}

/**
 * Total order for listing jobs newest-first. Primary key is `createdAt`
 * (descending); ties (jobs enqueued in the same millisecond) are broken by
 * `id` (ascending) so the order is fully deterministic. The previous
 * `a.createdAt < b.createdAt ? 1 : -1` never returned 0, so equal timestamps
 * produced an inconsistent (non-antisymmetric) comparator whose result varied
 * with the engine's sort internals — a source of flaky, load-dependent
 * ordering. A stable tiebreak removes that.
 */
export function compareJobsNewestFirst(a: RelayJob, b: RelayJob): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Whether a parked job is due to resume at reference time `refMs` (epoch ms).
 * A job is due when it's `waiting_for_reset` and its `resetAt` has arrived.
 *
 * Crucially, an **unparseable** `resetAt` — a malformed date string that can
 * slip in via an imported dump (`import`'s validation only checks it's a string,
 * not that it parses) or a hand-edited store — makes `new Date(resetAt).getTime()`
 * return `NaN`. The old inline `resetMs <= ref` check made `NaN <= ref` false, so
 * such a job was silently **never** returned by `listDue`: it sat in
 * `waiting_for_reset` forever, never resuming — precisely the "silent failure"
 * this tool exists to prevent. We instead treat an unparseable reset as **due
 * now**: a job we can't schedule is better surfaced and run (it either resumes,
 * or re-parks with a fresh valid `resetAt`, or fails) than orphaned indefinitely.
 * A `null` `resetAt` is *not* due (the job isn't genuinely parked on a reset).
 */
export function isJobDue(job: RelayJob, refMs: number): boolean {
  if (job.status !== "waiting_for_reset") return false;
  if (job.resetAt === null) return false;
  const resetMs = new Date(job.resetAt).getTime();
  if (Number.isNaN(resetMs)) return true; // unparseable → surface it, don't orphan
  return resetMs <= refMs;
}

export class RelayQueue {
  private filePath: string;
  private jobs: Map<string, RelayJob>;
  private onCorrupt?: RelayQueueOptions["onCorrupt"];

  constructor(filePath: string, options: RelayQueueOptions = {}) {
    this.filePath = filePath;
    this.onCorrupt = options.onCorrupt;
    mkdirSync(dirname(filePath), { recursive: true });
    this.jobs = new Map();
    this.load();
  }

  /**
   * No-op kept for API parity with the earlier SQLite-backed implementation.
   *
   * It deliberately does NOT write anything. Every mutating method already
   * persists atomically at call time (load → mutate → atomic flush), so there
   * are no deferred changes for `close()` to commit. The previous version
   * called `flush()` here, which re-wrote this instance's *in-memory* map —
   * a map loaded when the queue was opened and never refreshed for a read-only
   * command. That was a silent lost-update vector: opening the store for a
   * read (`status`, `stats`, `show`, `export`, …) and then closing it would
   * overwrite the file with a stale snapshot, clobbering any job a concurrent
   * process (e.g. a running `agentrelay daemon`) had enqueued or updated in the
   * meantime. Making close() a true no-op removes that write entirely, which
   * both matches this method's long-standing docstring and upholds the
   * lost-update-free invariant documented in concurrency.ts.
   */
  close() {}

  private load() {
    if (!existsSync(this.filePath)) {
      this.jobs = new Map();
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      // Can't even read the file (transient IO / permissions). Start fresh but
      // leave the file untouched so a later read can recover it.
      this.jobs = new Map();
      return;
    }
    // An empty (or whitespace-only) file is a legitimate "no jobs yet" state,
    // not corruption -- treat it as an empty queue without a backup.
    if (!raw.trim()) {
      this.jobs = new Map();
      return;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("store root is not a JSON array");
      this.jobs = new Map((parsed as RelayJob[]).map((job) => [job.id, job]));
    } catch (error) {
      // The file exists and has content but can't be parsed. Preserve it by
      // moving it aside to a timestamped `.corrupt-*` backup BEFORE starting
      // fresh -- otherwise the next flush() would overwrite (and permanently
      // destroy) the unreadable data. Then continue with an empty queue so the
      // relay loop keeps running.
      this.jobs = new Map();
      this.preserveCorruptFile(error);
    }
  }

  /** Moves the unreadable store file aside and notifies `onCorrupt`. */
  private preserveCorruptFile(error: unknown) {
    let backupPath: string | null = corruptBackupPath(this.filePath, new Date());
    try {
      renameSync(this.filePath, backupPath);
    } catch {
      // If it can't be moved (permissions / cross-device), leave it in place.
      // The next flush() may clobber it, but that's no worse than the previous
      // behavior, and we must not crash the relay over a backup failure.
      backupPath = null;
    }
    this.onCorrupt?.({ path: this.filePath, backupPath, error });
  }

  private flush() {
    const all = Array.from(this.jobs.values()).sort(compareJobsNewestFirst);
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmpPath, JSON.stringify(all, null, 2), "utf8");
    renameSync(tmpPath, this.filePath);
  }

  /** Re-reads the backing file so this instance sees writes made by another process. */
  refresh() {
    this.load();
  }

  enqueue(input: CreateJobInput): RelayJob {
    this.load();
    const now = new Date().toISOString();
    const job: RelayJob = {
      id: randomUUID(),
      project: input.project,
      tool: input.tool,
      command: input.command,
      cwd: input.cwd,
      status: "queued",
      resetAt: null,
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      lastError: null,
      lastOutputTail: null,
      lastRateLimit: null,
    };
    // Only persist the resume-context flag when opted in, so default stores stay
    // byte-for-byte unchanged (and older readers keep working).
    if (input.resumeContext) job.resumeContext = true;
    this.jobs.set(job.id, job);
    this.flush();
    return job;
  }

  /**
   * Park a job until its rate limit resets. When the caller passes the
   * `detection` provenance (which parser pattern matched, on what raw text),
   * it is persisted on the job so `agentrelay show` / the dashboard can explain
   * *why* the relay chose this reset time. Omit `detection` for reset times
   * that aren't a parsed rate limit (e.g. manual re-queues).
   */
  markWaitingForReset(id: string, resetAt: string, detection?: RateLimitDetection) {
    this.update(id, {
      status: "waiting_for_reset",
      resetAt,
      ...(detection ? { lastRateLimit: detection } : {}),
    });
  }

  /**
   * Re-queue a job that hit a *transient* failure (spawn error / non-zero exit)
   * to be retried after a backoff delay. Like {@link markWaitingForReset} it
   * uses the `waiting_for_reset` status so `listDue` picks it up, but it also
   * records the failure reason so `agentrelay status` / the dashboard can show
   * why it's waiting.
   */
  markRetryScheduled(id: string, resetAt: string, error: string) {
    this.update(id, { status: "waiting_for_reset", resetAt, lastError: error });
  }

  markResuming(id: string) {
    const current = this.getById(id);
    this.update(id, { status: "resuming", attempts: (current?.attempts ?? 0) + 1 });
  }

  markCompleted(id: string, outputTail?: string) {
    this.update(id, { status: "completed", lastOutputTail: outputTail ?? null });
  }

  markFailed(id: string, error: string, outputTail?: string) {
    this.update(id, { status: "failed", lastError: error, lastOutputTail: outputTail ?? null });
  }

  /**
   * Call off a pending job (user-initiated). Moves it to the terminal
   * `cancelled` state so the scheduler stops relaying it. A no-op if the id
   * is unknown; callers guard cancellability via {@link canCancel}.
   */
  markCancelled(id: string) {
    // Clear resetAt so `status` shows no misleading countdown for a job that
    // will never resume.
    this.update(id, { status: "cancelled", resetAt: null });
  }

  /**
   * Force a job to be due immediately so the next scheduler tick resumes it
   * (user-initiated retry). Attempts are reset to 0 and the last error is
   * cleared, so retrying a job that already exhausted its attempt budget gets
   * a fresh run rather than instantly re-failing the retry check.
   */
  requeueNow(id: string, at: string = new Date().toISOString()) {
    this.update(id, { status: "waiting_for_reset", resetAt: at, attempts: 0, lastError: null });
  }

  /**
   * Reclaim a job orphaned mid-resume: a resume loop that died between
   * {@link markResuming} and a terminal mark leaves the job stuck in `resuming`,
   * where no `listDue` tick will ever pick it up again. This moves it back to
   * `waiting_for_reset` due immediately (`resetAt = at`) so the next tick
   * resumes it, records why it's waiting, and — deliberately unlike
   * {@link requeueNow} — **preserves `attempts`**: the interrupted attempt still
   * counts, so a job that keeps crashing the loop can't be recovered forever.
   *
   * A no-op returning `false` unless the job is currently `resuming`, so it's
   * safe to call on any id (e.g. after re-reading the store) without racing a
   * genuinely in-flight run into a duplicate resume.
   */
  recoverResuming(id: string, at: string = new Date().toISOString()): boolean {
    const current = this.getById(id);
    if (current?.status !== "resuming") return false;
    this.update(id, {
      status: "waiting_for_reset",
      resetAt: at,
      lastError: "recovered from an interrupted resume (resume loop stopped mid-attempt)",
    });
    return true;
  }

  private update(id: string, patch: Partial<RelayJob> & { status: JobStatus }) {
    this.load();
    const existing = this.jobs.get(id);
    if (!existing) return;
    const updated: RelayJob = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.jobs.set(id, updated);
    this.flush();
  }

  getById(id: string): RelayJob | undefined {
    this.load();
    return this.jobs.get(id);
  }

  listAll(): RelayJob[] {
    this.load();
    return Array.from(this.jobs.values()).sort(compareJobsNewestFirst);
  }

  /**
   * Removes finished jobs from the store according to `options` (status / age /
   * keep-last rules — see {@link selectPrunableJobs}) and returns the jobs that
   * were removed. Active jobs are never touched unless a caller explicitly
   * includes their status. Pass `dryRun: true` to compute the selection without
   * mutating the store (nothing is written).
   */
  prune(options: PruneOptions & { dryRun?: boolean } = {}): RelayJob[] {
    this.load();
    const { prune } = selectPrunableJobs(Array.from(this.jobs.values()), options);
    if (options.dryRun || prune.length === 0) return prune;
    for (const job of prune) {
      this.jobs.delete(job.id);
    }
    this.flush();
    return prune;
  }

  /**
   * Scrub persisted secrets from every job's free-text fields
   * (`lastOutputTail`, `lastError`, `lastRateLimit.rawMatch`) in place, using
   * the same recognizer the scheduler applies at write time (see
   * {@link redactSecrets}). Where the scheduler only protects *new* writes going
   * forward, this reaches jobs stored before redaction existed, imported from an
   * external dump, or hand-edited — the plaintext credentials that `show`/
   * `export` would otherwise surface. Returns the plan (per-job change log +
   * totals); pass `dryRun: true` to compute it without writing. A job whose
   * fields need no change keeps its exact `updatedAt`, so the sweep never
   * perturbs lifecycle timing.
   */
  redact(options: { dryRun?: boolean } = {}): StoreRedactionPlan {
    this.load();
    const plan = planStoreRedaction(Array.from(this.jobs.values()));
    if (options.dryRun || plan.changes.length === 0) return plan;
    const changedIds = new Set(plan.changes.map((c) => c.id));
    for (const job of plan.jobs) {
      if (changedIds.has(job.id)) this.jobs.set(job.id, job);
    }
    this.flush();
    return plan;
  }

  /**
   * Writes a timestamped snapshot of the store next to it
   * (`jobs.json.backup-<ts>`) and rotates old snapshots, keeping the newest
   * `keepLast` (default {@link DEFAULT_BACKUP_KEEP}). Returns the new path, the
   * job count captured, and the snapshots removed by rotation.
   *
   * The snapshot is written atomically (temp file + rename) and reflects the
   * current on-disk state, so even an empty store yields a valid `[]` snapshot.
   * Rotation only ever touches this store's own `.backup-*` files — never the
   * live store, a `.corrupt-*` recovery copy, or a `.tmp-*` write — and the
   * just-written snapshot is always spared even at `keepLast: 0`. A failure to
   * delete an old snapshot is swallowed so a backup never breaks the relay.
   */
  backup(options: { keepLast?: number; now?: Date } = {}): BackupResult {
    this.load();
    const now = options.now ?? new Date();
    const dest = backupFilePath(this.filePath, now);
    const all = Array.from(this.jobs.values()).sort(compareJobsNewestFirst);

    // Atomic write via a `.tmp-*` temp file (NOT `.backup-*`, so rotation's
    // pattern never matches an in-flight snapshot).
    const tmpPath = `${this.filePath}.tmp-backup-${process.pid}-${Date.now()}`;
    writeFileSync(tmpPath, JSON.stringify(all, null, 2), "utf8");
    renameSync(tmpPath, dest);

    const keepLast = options.keepLast ?? DEFAULT_BACKUP_KEEP;
    const dir = dirname(this.filePath);
    const storeName = basename(this.filePath);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      names = [];
    }
    const rotated: string[] = [];
    for (const name of selectRotatableBackups(names, storeName, keepLast)) {
      const full = join(dir, name);
      // Never delete the snapshot we just made (guards keepLast: 0).
      if (full === dest) continue;
      try {
        unlinkSync(full);
        rotated.push(full);
      } catch {
        // Best-effort rotation: a delete failure must not break anything.
      }
    }

    return { path: dest, jobCount: all.length, rotated };
  }

  /**
   * Replaces the store's contents with those of a snapshot file (`from`) — the
   * inverse of {@link backup}. The snapshot is fully read and validated (must be
   * a JSON array of jobs) *before* the live store is touched, so a bad snapshot
   * throws without destroying current data. By default the current store is
   * first snapshotted (`.backup-<ts>`) so a restore is itself undoable; pass
   * `backupCurrent: false` to skip that. Returns the source, the restored job
   * count, and where the previous store was backed up (or null).
   */
  restore(options: { from: string; backupCurrent?: boolean; now?: Date }): RestoreResult {
    const { from } = options;
    // Validate the snapshot BEFORE mutating anything. A parse failure or a
    // non-array root throws here, leaving the live store intact.
    const raw = readFileSync(from, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`snapshot ${from} is not a JSON array of jobs`);
    }
    const jobs = parsed as RelayJob[];

    // Safety net: snapshot the current store first so the restore is undoable.
    // `backup()` reloads from disk, so this captures the real current state,
    // and `jobs` above already holds the source content — safe even if `from`
    // is itself an old snapshot that rotation might touch.
    let backedUpTo: string | null = null;
    const backupCurrent = options.backupCurrent ?? true;
    if (backupCurrent && existsSync(this.filePath)) {
      backedUpTo = this.backup({ now: options.now }).path;
    }

    this.jobs = new Map(jobs.map((job) => [job.id, job]));
    this.flush();
    return { from, jobCount: jobs.length, backedUpTo };
  }

  /**
   * Reports what {@link restore} would do for snapshot `from` *without* touching
   * the live store — a dry run. The snapshot is read and validated with the same
   * rules as `restore` (must parse to a JSON array of jobs), so a broken snapshot
   * throws here too and the preview never claims a bad file is restorable. The
   * live store is only read (to count what would be replaced), never written.
   */
  previewRestore(options: { from: string; backupCurrent?: boolean }): RestorePreview {
    const { from } = options;
    const raw = readFileSync(from, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`snapshot ${from} is not a JSON array of jobs`);
    }
    const jobs = parsed as RelayJob[];

    this.load();
    const currentJobCount = this.jobs.size;
    const wouldBackUp = (options.backupCurrent ?? true) && existsSync(this.filePath);
    return { from, jobCount: jobs.length, currentJobCount, wouldBackUp };
  }

  /**
   * Merge already-validated jobs into the store — the write side of the
   * `import` command (the inverse of {@link backup}/export). Delegates the
   * decision of what happens to each record to the pure {@link planImport}
   * (add / overwrite / skip existing / skip active), then applies `toAdd` +
   * `toUpdate` in one atomic flush. By default only terminal-state jobs are
   * ingested and existing ids are never overwritten (see {@link ImportOptions});
   * nothing is written when the plan touches no jobs, so a pure-skip import
   * leaves the file (and its mtime) untouched.
   */
  importJobs(incoming: RelayJob[], options: ImportOptions = {}): ImportResult {
    this.load();
    const plan = planImport(Array.from(this.jobs.values()), incoming, options);
    const applied = [...plan.toAdd, ...plan.toUpdate];
    if (applied.length > 0) {
      for (const job of applied) {
        this.jobs.set(job.id, job);
      }
      this.flush();
    }
    return summarizeImportPlan(plan);
  }

  /** Jobs whose reset time has already passed and are ready to be resumed now. */
  listDue(referenceTime: Date = new Date()): RelayJob[] {
    this.load();
    const ref = referenceTime.getTime();
    return Array.from(this.jobs.values()).filter((job) => isJobDue(job, ref));
  }
}
