import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CorruptStoreInfo, compareJobsNewestFirst, corruptBackupPath, RelayQueue } from "./queue.js";
import type { CreateJobInput, RateLimitDetection, RelayJob } from "./types.js";

// These tests exercise the real on-disk JSON store — the single source of
// truth for the whole relay — against a throwaway temp directory, so they cover
// the actual filesystem behaviour (atomic writes, corruption recovery, external
// writes) rather than a mock. Each test gets its own directory and cleans up.

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentrelay-queue-"));
  storePath = join(dir, "jobs.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function input(overrides: Partial<CreateJobInput> = {}): CreateJobInput {
  return {
    project: "web",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/work/web",
    ...overrides,
  };
}

/** Read the raw store file back as parsed JSON (what a concurrent reader sees). */
function readStore(path: string = storePath): RelayJob[] {
  return JSON.parse(readFileSync(path, "utf8")) as RelayJob[];
}

describe("compareJobsNewestFirst", () => {
  const at = (createdAt: string, id: string): RelayJob => ({ id, createdAt }) as unknown as RelayJob;

  it("orders newer createdAt first", () => {
    expect(compareJobsNewestFirst(at("2026-01-02T00:00:00Z", "a"), at("2026-01-01T00:00:00Z", "b"))).toBeLessThan(0);
    expect(compareJobsNewestFirst(at("2026-01-01T00:00:00Z", "a"), at("2026-01-02T00:00:00Z", "b"))).toBeGreaterThan(0);
  });

  it("breaks equal-timestamp ties by id ascending and is antisymmetric", () => {
    const x = at("2026-01-01T00:00:00Z", "aaa");
    const y = at("2026-01-01T00:00:00Z", "bbb");
    expect(compareJobsNewestFirst(x, y)).toBeLessThan(0);
    expect(compareJobsNewestFirst(y, x)).toBeGreaterThan(0);
  });

  it("returns exactly 0 for the same createdAt and id (reflexive/stable)", () => {
    const x = at("2026-01-01T00:00:00Z", "same");
    expect(compareJobsNewestFirst(x, x)).toBe(0);
  });
});

describe("corruptBackupPath", () => {
  it("appends a filesystem-safe timestamped suffix (no ':' or '.')", () => {
    const p = corruptBackupPath("/x/jobs.json", new Date("2026-08-11T17:38:27.123Z"));
    expect(p).toBe("/x/jobs.json.corrupt-2026-08-11T17-38-27-123Z");
    // The timestamp segment (after `corrupt-`) must be free of ':' and '.',
    // which are illegal / awkward in filenames on some platforms.
    const stamp = p.slice(p.indexOf(".corrupt-") + ".corrupt-".length);
    expect(stamp).not.toMatch(/[:.]/);
  });
});

describe("RelayQueue.enqueue", () => {
  it("creates a queued job with sane defaults and a uuid", () => {
    const q = new RelayQueue(storePath);
    const job = q.enqueue(input());
    expect(job.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(job.status).toBe("queued");
    expect(job.resetAt).toBeNull();
    expect(job.attempts).toBe(0);
    expect(job.lastError).toBeNull();
    expect(job.lastOutputTail).toBeNull();
    expect(job.lastRateLimit).toBeNull();
    expect(job.project).toBe("web");
    expect(job.tool).toBe("claude-code");
    expect(job.command).toEqual(["claude", "-p", "continue"]);
    expect(job.createdAt).toBe(job.updatedAt);
  });

  it("persists atomically so a fresh instance reads the same job", () => {
    const q = new RelayQueue(storePath);
    const job = q.enqueue(input());
    const reopened = new RelayQueue(storePath);
    expect(reopened.getById(job.id)).toEqual(job);
    // The on-disk file is valid JSON, not a half-written temp file.
    expect(readStore()).toHaveLength(1);
  });

  it("appends across instances instead of clobbering (multi-writer merge)", () => {
    const a = q().enqueue(input({ project: "a" }));
    // A second, independent queue object over the same file must not lose `a`.
    const b = new RelayQueue(storePath).enqueue(input({ project: "b" }));
    expect(
      new RelayQueue(storePath)
        .listAll()
        .map((j) => j.id)
        .sort()
    ).toEqual([a.id, b.id].sort());
  });
});

function q(): RelayQueue {
  return new RelayQueue(storePath);
}

describe("RelayQueue mutators", () => {
  it("markWaitingForReset sets status + resetAt, without detection leaves provenance null", () => {
    const store = q();
    const job = store.enqueue(input());
    store.markWaitingForReset(job.id, "2026-08-12T00:00:00Z");
    const after = store.getById(job.id);
    expect(after?.status).toBe("waiting_for_reset");
    expect(after?.resetAt).toBe("2026-08-12T00:00:00Z");
    expect(after?.lastRateLimit ?? null).toBeNull();
  });

  it("markWaitingForReset persists rate-limit provenance when supplied", () => {
    const store = q();
    const job = store.enqueue(input());
    const detection: RateLimitDetection = {
      pattern: "resets-at-iso",
      rawMatch: "resets at 2026-08-12T00:00:00Z",
      resetAt: "2026-08-12T00:00:00Z",
      detectedAt: "2026-08-11T17:00:00Z",
    };
    store.markWaitingForReset(job.id, detection.resetAt, detection);
    expect(store.getById(job.id)?.lastRateLimit).toEqual(detection);
  });

  it("markRetryScheduled parks the job and records the failure reason", () => {
    const store = q();
    const job = store.enqueue(input());
    store.markRetryScheduled(job.id, "2026-08-12T00:00:00Z", "spawn ENOENT");
    const after = store.getById(job.id);
    expect(after?.status).toBe("waiting_for_reset");
    expect(after?.resetAt).toBe("2026-08-12T00:00:00Z");
    expect(after?.lastError).toBe("spawn ENOENT");
  });

  it("markResuming increments attempts each time", () => {
    const store = q();
    const job = store.enqueue(input());
    store.markResuming(job.id);
    expect(store.getById(job.id)?.attempts).toBe(1);
    store.markResuming(job.id);
    const after = store.getById(job.id);
    expect(after?.attempts).toBe(2);
    expect(after?.status).toBe("resuming");
  });

  it("markCompleted / markFailed capture the output tail and error", () => {
    const store = q();
    const done = store.enqueue(input());
    store.markCompleted(done.id, "...last lines...");
    expect(store.getById(done.id)?.status).toBe("completed");
    expect(store.getById(done.id)?.lastOutputTail).toBe("...last lines...");

    const bad = store.enqueue(input());
    store.markFailed(bad.id, "exit 1", "boom");
    const afterFail = store.getById(bad.id);
    expect(afterFail?.status).toBe("failed");
    expect(afterFail?.lastError).toBe("exit 1");
    expect(afterFail?.lastOutputTail).toBe("boom");
  });

  it("markCompleted defaults the output tail to null when omitted", () => {
    const store = q();
    const job = store.enqueue(input());
    store.markCompleted(job.id);
    expect(store.getById(job.id)?.lastOutputTail).toBeNull();
  });

  it("markCancelled moves to cancelled and clears the misleading countdown", () => {
    const store = q();
    const job = store.enqueue(input());
    store.markWaitingForReset(job.id, "2026-08-12T00:00:00Z");
    store.markCancelled(job.id);
    const after = store.getById(job.id);
    expect(after?.status).toBe("cancelled");
    expect(after?.resetAt).toBeNull();
  });

  it("requeueNow makes the job due, resets attempts to 0, and clears lastError", () => {
    const store = q();
    const job = store.enqueue(input());
    store.markResuming(job.id);
    store.markFailed(job.id, "exit 1");
    store.requeueNow(job.id, "2026-08-11T18:00:00Z");
    const after = store.getById(job.id);
    expect(after?.status).toBe("waiting_for_reset");
    expect(after?.resetAt).toBe("2026-08-11T18:00:00Z");
    expect(after?.attempts).toBe(0);
    expect(after?.lastError).toBeNull();
  });

  it("mutating an unknown id is a silent no-op (store unchanged)", () => {
    const store = q();
    store.enqueue(input());
    const before = readStore();
    store.markCompleted("does-not-exist");
    store.markCancelled("nope");
    store.markResuming("nope");
    expect(readStore()).toEqual(before);
  });

  it("bumps updatedAt on each mutation", async () => {
    const store = q();
    const job = store.enqueue(input());
    // Ensure the clock advances at least a millisecond.
    await new Promise((r) => setTimeout(r, 2));
    store.markResuming(job.id);
    const after = store.getById(job.id);
    expect(after).toBeDefined();
    expect(after?.updatedAt).not.toBe(job.updatedAt);
    const updatedAt = after?.updatedAt ?? "";
    expect(new Date(updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(job.createdAt).getTime());
  });
});

describe("RelayQueue.listDue", () => {
  it("returns only waiting_for_reset jobs whose reset is at or before the reference", () => {
    const store = q();
    const past = store.enqueue(input({ project: "past" }));
    const future = store.enqueue(input({ project: "future" }));
    const queued = store.enqueue(input({ project: "queued" }));
    const resuming = store.enqueue(input({ project: "resuming" }));
    store.markWaitingForReset(past.id, "2026-08-11T00:00:00Z");
    store.markWaitingForReset(future.id, "2027-01-01T00:00:00Z");
    store.markResuming(resuming.id);

    const due = store.listDue(new Date("2026-08-11T12:00:00Z"));
    const ids = due.map((j) => j.id);
    expect(ids).toContain(past.id);
    expect(ids).not.toContain(future.id); // reset still in the future
    expect(ids).not.toContain(queued.id); // never parked
    expect(ids).not.toContain(resuming.id); // already being resumed
  });

  it("treats a reset exactly at the reference time as due (inclusive)", () => {
    const store = q();
    const job = store.enqueue(input());
    store.markWaitingForReset(job.id, "2026-08-11T12:00:00.000Z");
    expect(store.listDue(new Date("2026-08-11T12:00:00.000Z")).map((j) => j.id)).toContain(job.id);
  });
});

describe("RelayQueue.refresh", () => {
  it("picks up a write made by another process", () => {
    const store = q();
    const job = store.enqueue(input());
    // Simulate a second process appending a job directly to the file.
    const external: RelayJob = { ...job, id: "external-id", project: "other" };
    writeFileSync(storePath, JSON.stringify([job, external], null, 2), "utf8");
    // getById reloads internally, so the external job is visible without an
    // explicit refresh — but refresh() is the documented way and must also work.
    store.refresh();
    expect(store.getById("external-id")?.project).toBe("other");
    expect(store.listAll()).toHaveLength(2);
  });
});

describe("RelayQueue corruption recovery (failure injection)", () => {
  it("treats a missing file as an empty queue without a backup or callback", () => {
    let called = false;
    const store = new RelayQueue(storePath, {
      onCorrupt: () => {
        called = true;
      },
    });
    expect(store.listAll()).toEqual([]);
    expect(called).toBe(false);
  });

  it("treats a whitespace-only file as an empty queue (not corruption)", () => {
    writeFileSync(storePath, "   \n\t ", "utf8");
    let called = false;
    const store = new RelayQueue(storePath, {
      onCorrupt: () => {
        called = true;
      },
    });
    expect(store.listAll()).toEqual([]);
    expect(called).toBe(false);
    // No `.corrupt-*` sibling should have been created.
    expect(readdirSync(dir)).not.toContainEqual(expect.stringContaining(".corrupt-"));
  });

  it("moves an unparseable file aside to a .corrupt-* backup and starts fresh", () => {
    writeFileSync(storePath, "{ this is not valid json", "utf8");
    const seen: CorruptStoreInfo[] = [];
    const store = new RelayQueue(storePath, { onCorrupt: (info) => seen.push(info) });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe(storePath);
    expect(seen[0]?.backupPath).toMatch(/\.corrupt-/);
    expect(store.listAll()).toEqual([]);

    const backupPath = seen[0]?.backupPath ?? "";
    expect(backupPath).not.toBe("");
    // The corrupt bytes are preserved in the backup, and a subsequent flush
    // (via enqueue) must NOT destroy that backup.
    expect(readFileSync(backupPath, "utf8")).toBe("{ this is not valid json");
    store.enqueue(input());
    expect(readFileSync(backupPath, "utf8")).toBe("{ this is not valid json");
    expect(readStore()).toHaveLength(1);
  });

  it("treats a non-array JSON root as corruption", () => {
    writeFileSync(storePath, JSON.stringify({ jobs: [] }), "utf8");
    const seen: CorruptStoreInfo[] = [];
    const store = new RelayQueue(storePath, { onCorrupt: (info) => seen.push(info) });
    expect(seen).toHaveLength(1);
    expect(store.listAll()).toEqual([]);
  });
});

describe("RelayQueue.prune", () => {
  it("removes terminal jobs and leaves active ones", () => {
    const store = q();
    const done = store.enqueue(input());
    const active = store.enqueue(input());
    store.markCompleted(done.id);
    const removed = store.prune();
    expect(removed.map((j) => j.id)).toEqual([done.id]);
    expect(store.listAll().map((j) => j.id)).toEqual([active.id]);
  });

  it("dryRun computes the selection without writing", () => {
    const store = q();
    const done = store.enqueue(input());
    store.markFailed(done.id, "x");
    const before = readStore();
    const removed = store.prune({ dryRun: true });
    expect(removed.map((j) => j.id)).toEqual([done.id]);
    expect(readStore()).toEqual(before);
  });
});

describe("RelayQueue.backup / restore", () => {
  it("backup writes a snapshot reflecting current state and returns its path", () => {
    const store = q();
    store.enqueue(input());
    const result = store.backup({ now: new Date("2026-08-11T17:00:00Z") });
    expect(result.jobCount).toBe(1);
    expect(readStore(result.path)).toHaveLength(1);
  });

  it("restore replaces contents and snapshots the current store first", () => {
    const store = q();
    const original = store.enqueue(input({ project: "original" }));
    const snapPath = join(dir, "snapshot.json");
    const snapshotJob: RelayJob = { ...original, id: "snap-id", project: "restored" };
    writeFileSync(snapPath, JSON.stringify([snapshotJob], null, 2), "utf8");

    const result = store.restore({ from: snapPath, now: new Date("2026-08-11T17:00:00Z") });
    expect(result.jobCount).toBe(1);
    expect(result.backedUpTo).not.toBeNull();
    expect(store.listAll().map((j) => j.id)).toEqual(["snap-id"]);
    // The pre-restore state is recoverable from the safety backup.
    const backedUpTo = result.backedUpTo ?? "";
    expect(backedUpTo).not.toBe("");
    expect(readStore(backedUpTo).map((j) => j.id)).toEqual([original.id]);
  });

  it("restore rejects a non-array snapshot without touching the live store", () => {
    const store = q();
    const original = store.enqueue(input());
    const badSnap = join(dir, "bad.json");
    writeFileSync(badSnap, JSON.stringify({ not: "an array" }), "utf8");
    expect(() => store.restore({ from: badSnap })).toThrow();
    expect(store.listAll().map((j) => j.id)).toEqual([original.id]);
  });

  it("previewRestore reports the change without mutating anything", () => {
    const store = q();
    const original = store.enqueue(input());
    const snapPath = join(dir, "snapshot.json");
    writeFileSync(
      snapPath,
      JSON.stringify(
        [
          { ...original, id: "s1" },
          { ...original, id: "s2" },
        ],
        null,
        2
      ),
      "utf8"
    );
    const before = readStore();
    const preview = store.previewRestore({ from: snapPath });
    expect(preview.jobCount).toBe(2);
    expect(preview.currentJobCount).toBe(1);
    expect(preview.wouldBackUp).toBe(true);
    expect(readStore()).toEqual(before);
  });
});

describe("RelayQueue.importJobs", () => {
  it("adds terminal incoming jobs and skips existing ids by default", () => {
    const store = q();
    const existing = store.enqueue(input({ project: "existing" }));
    store.markCompleted(existing.id); // terminal, so it isn't skipped as "active"
    const incoming: RelayJob[] = [
      // Same id, terminal status → collides with an existing id → skippedExisting.
      { ...existing, status: "completed", project: "SHOULD-NOT-OVERWRITE" },
      // Fresh id, terminal status → added.
      { ...existing, id: "imported-1", status: "completed", project: "imported" },
    ];
    const result = store.importJobs(incoming);
    expect(result.added).toBe(1);
    expect(result.skippedExisting).toBe(1);
    expect(store.getById(existing.id)?.project).toBe("existing"); // untouched
    expect(store.getById("imported-1")?.project).toBe("imported");
  });
});
