import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canDelete, DELETABLE_STATUSES } from "./control.js";
import { RelayQueue } from "./queue.js";
import type { JobStatus, RelayJob } from "./types.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "alpha",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "completed",
    resetAt: null,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

const ALL_STATUSES: JobStatus[] = ["queued", "waiting_for_reset", "resuming", "completed", "failed", "cancelled"];

describe("canDelete", () => {
  it("allows deleting every terminal status without force", () => {
    for (const status of DELETABLE_STATUSES) {
      expect(canDelete(job({ status })).ok).toBe(true);
    }
  });

  it("rejects deleting active jobs and names the status in the reason", () => {
    for (const status of ["queued", "waiting_for_reset", "resuming"] as JobStatus[]) {
      const result = canDelete(job({ status }));
      expect(result.ok).toBe(false);
      expect(result.reason).toContain(status);
      expect(result.reason).toContain("--force");
    }
  });

  it("covers every job status (guarded xor deletable, no gaps)", () => {
    for (const status of ALL_STATUSES) {
      const deletable = (DELETABLE_STATUSES as readonly string[]).includes(status);
      expect(canDelete(job({ status })).ok).toBe(deletable);
    }
  });

  it("DELETABLE_STATUSES is exactly the three terminal states", () => {
    expect([...DELETABLE_STATUSES].sort()).toEqual(["cancelled", "completed", "failed"]);
  });
});

describe("RelayQueue.remove", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-rm-"));
    storePath = join(dir, "jobs.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("removes a job by id and persists the deletion", () => {
    const queue = new RelayQueue(storePath);
    const a = queue.enqueue({ project: "alpha", tool: "claude-code", command: ["claude"], cwd: "/tmp" });
    const b = queue.enqueue({ project: "beta", tool: "claude-code", command: ["claude"], cwd: "/tmp" });

    expect(queue.remove(a.id)).toBe(true);
    expect(queue.getById(a.id)).toBeUndefined();
    expect(queue.getById(b.id)?.id).toBe(b.id);
    queue.close();

    // A fresh instance sees the on-disk store: the deletion was flushed.
    const reopened = new RelayQueue(storePath);
    expect(reopened.getById(a.id)).toBeUndefined();
    expect(reopened.listAll().map((j) => j.id)).toEqual([b.id]);
    reopened.close();
  });

  it("returns false for an unknown id and leaves the store untouched", () => {
    const queue = new RelayQueue(storePath);
    const a = queue.enqueue({ project: "alpha", tool: "claude-code", command: ["claude"], cwd: "/tmp" });

    expect(queue.remove("does-not-exist")).toBe(false);
    expect(queue.listAll().map((j) => j.id)).toEqual([a.id]);
    queue.close();
  });
});
