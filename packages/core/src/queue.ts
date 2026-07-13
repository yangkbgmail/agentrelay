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
import { mkdirSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CreateJobInput, JobStatus, RelayJob } from "./types.js";

export class RelayQueue {
  private filePath: string;
  private jobs: Map<string, RelayJob>;

  constructor(filePath: string) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    this.jobs = new Map();
    this.load();
  }

  /** No-op kept for API parity with earlier SQLite-backed implementation. */
  close() {
    this.flush();
  }

  private load() {
    if (!existsSync(this.filePath)) {
      this.jobs = new Map();
      return;
    }
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed: RelayJob[] = raw.trim() ? JSON.parse(raw) : [];
      // Back-compat: `retryCount` was added after the first releases, so jobs
      // written by older versions won't have it. Default to 0 on read.
      this.jobs = new Map(
        parsed.map((job) => [job.id, { ...job, retryCount: job.retryCount ?? 0 }])
      );
    } catch {
      // Corrupt or empty file: start fresh rather than crashing the whole
      // relay loop. The bad file is left in place for a human to inspect.
      this.jobs = new Map();
    }
  }

  private flush() {
    const all = Array.from(this.jobs.values()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
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
      retryCount: 0,
      lastError: null,
      lastOutputTail: null,
    };
    this.jobs.set(job.id, job);
    this.flush();
    return job;
  }

  markWaitingForReset(id: string, resetAt: string) {
    this.update(id, { status: "waiting_for_reset", resetAt });
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
   * Re-queues a job that *failed* (not rate-limited) for a backoff retry.
   * Bumps `retryCount`, records the error, and parks the job in
   * `waiting_for_reset` with `resetAt` set to when the retry should fire —
   * so the existing `listDue` polling picks it up with no extra machinery.
   */
  markRetry(id: string, retryAt: string, error: string, outputTail?: string) {
    const current = this.getById(id);
    this.update(id, {
      status: "waiting_for_reset",
      resetAt: retryAt,
      retryCount: (current?.retryCount ?? 0) + 1,
      lastError: error,
      lastOutputTail: outputTail ?? current?.lastOutputTail ?? null,
    });
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
    return Array.from(this.jobs.values()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** Jobs whose reset time has already passed and are ready to be resumed now. */
  listDue(referenceTime: Date = new Date()): RelayJob[] {
    this.load();
    const ref = referenceTime.getTime();
    return Array.from(this.jobs.values()).filter(
      (job) => job.status === "waiting_for_reset" && job.resetAt !== null && new Date(job.resetAt).getTime() <= ref
    );
  }
}
