import { describe, expect, it } from "vitest";
import { buildReplayJob, canCancel, canRequeue, partitionForControl, resolveJobId } from "../src/control.js";
import type { JobStatus, RelayJob } from "../src/types.js";

function job(id: string, status: JobStatus): RelayJob {
  const now = "2026-07-13T00:00:00.000Z";
  return {
    id,
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status,
    resetAt: null,
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    lastError: null,
    lastOutputTail: null,
  };
}

describe("canCancel", () => {
  it("allows cancelling pending jobs", () => {
    for (const status of ["queued", "waiting_for_reset", "resuming"] as JobStatus[]) {
      expect(canCancel(job("a", status)).ok).toBe(true);
    }
  });

  it("rejects cancelling terminal or already-cancelled jobs", () => {
    for (const status of ["completed", "failed", "cancelled"] as JobStatus[]) {
      const result = canCancel(job("a", status));
      expect(result.ok).toBe(false);
      expect(result.reason).toBeTruthy();
    }
  });
});

describe("canRequeue", () => {
  it("allows requeueing any job that is not mid-flight", () => {
    for (const status of ["queued", "waiting_for_reset", "completed", "failed", "cancelled"] as JobStatus[]) {
      expect(canRequeue(job("a", status)).ok).toBe(true);
    }
  });

  it("rejects requeueing a job that is currently resuming", () => {
    const result = canRequeue(job("a", "resuming"));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("resuming");
  });
});

describe("partitionForControl", () => {
  it("splits jobs into eligible and ineligible by the guard", () => {
    const jobs = [job("a", "queued"), job("b", "completed"), job("c", "waiting_for_reset"), job("d", "cancelled")];
    const { eligible, ineligible } = partitionForControl(jobs, canCancel);
    expect(eligible.map((j) => j.id)).toEqual(["a", "c"]);
    expect(ineligible.map((i) => i.job.id)).toEqual(["b", "d"]);
    // Every ineligible entry carries the guard's reason.
    for (const entry of ineligible) expect(entry.reason).toBeTruthy();
  });

  it("preserves input order and never mutates the input", () => {
    const jobs = [job("x", "resuming"), job("y", "queued")];
    const snapshot = jobs.map((j) => j.id);
    const { eligible, ineligible } = partitionForControl(jobs, canRequeue);
    expect(eligible.map((j) => j.id)).toEqual(["y"]);
    expect(ineligible.map((i) => i.job.id)).toEqual(["x"]);
    expect(jobs.map((j) => j.id)).toEqual(snapshot);
  });

  it("returns all eligible when the guard accepts everything", () => {
    const jobs = [job("a", "queued"), job("b", "waiting_for_reset")];
    const { eligible, ineligible } = partitionForControl(jobs, canCancel);
    expect(eligible).toHaveLength(2);
    expect(ineligible).toHaveLength(0);
  });

  it("returns all ineligible when the guard rejects everything", () => {
    const jobs = [job("a", "completed"), job("b", "failed")];
    const { eligible, ineligible } = partitionForControl(jobs, canCancel);
    expect(eligible).toHaveLength(0);
    expect(ineligible).toHaveLength(2);
  });

  it("handles an empty job list", () => {
    const { eligible, ineligible } = partitionForControl([], canCancel);
    expect(eligible).toEqual([]);
    expect(ineligible).toEqual([]);
  });
});

describe("resolveJobId", () => {
  const jobs = [job("aaaa1111-2222-3333", "queued"), job("aaaa9999-8888-7777", "failed"), job("bbbb0000", "completed")];

  it("matches a full id exactly", () => {
    expect(resolveJobId(jobs, "aaaa1111-2222-3333")).toEqual({ id: "aaaa1111-2222-3333" });
  });

  it("matches a unique prefix", () => {
    expect(resolveJobId(jobs, "bbbb")).toEqual({ id: "bbbb0000" });
  });

  it("rejects an ambiguous prefix", () => {
    const result = resolveJobId(jobs, "aaaa");
    expect(result.id).toBeUndefined();
    expect(result.error).toContain("ambiguous");
  });

  it("rejects an unknown id", () => {
    const result = resolveJobId(jobs, "zzzz");
    expect(result.id).toBeUndefined();
    expect(result.error).toContain("no job matches");
  });

  it("rejects an empty id", () => {
    expect(resolveJobId(jobs, "   ").error).toBe("no job id given");
  });

  it("prefers an exact match over a prefix collision", () => {
    // A short id that is also a prefix of a longer one must still resolve to itself.
    const withCollision = [job("ab", "queued"), job("abc", "failed")];
    expect(resolveJobId(withCollision, "ab")).toEqual({ id: "ab" });
  });
});

describe("buildReplayJob", () => {
  const NOW = "2026-08-01T10:00:00.000Z";

  function finished(overrides: Partial<RelayJob> = {}): RelayJob {
    return {
      ...job("src", "completed"),
      attempts: 3,
      resetAt: "2026-07-30T17:00:00.000Z",
      lastError: "boom",
      lastOutputTail: "some output",
      lastRateLimit: {
        pattern: "clock-time",
        rawMatch: "resets at 5pm",
        resetAt: "2026-07-30T17:00:00.000Z",
        detectedAt: "2026-07-30T12:00:00.000Z",
      },
      ...overrides,
    };
  }

  it("carries over only the reusable fields (project/tool/command/cwd)", () => {
    const clone = buildReplayJob(finished(), { id: "new-1", now: NOW });
    expect(clone.project).toBe("demo");
    expect(clone.tool).toBe("claude-code");
    expect(clone.command).toEqual(["claude", "-p", "continue"]);
    expect(clone.cwd).toBe("/tmp/demo");
  });

  it("gives the clone the injected id and a clean, due-now history", () => {
    const clone = buildReplayJob(finished(), { id: "new-2", now: NOW });
    expect(clone.id).toBe("new-2");
    expect(clone.status).toBe("waiting_for_reset");
    // resetAt = now so the scheduler's listDue picks it up immediately.
    expect(clone.resetAt).toBe(NOW);
    expect(clone.createdAt).toBe(NOW);
    expect(clone.updatedAt).toBe(NOW);
    expect(clone.attempts).toBe(0);
    expect(clone.lastError).toBeNull();
    expect(clone.lastOutputTail).toBeNull();
    expect(clone.lastRateLimit).toBeNull();
  });

  it("copies the command array rather than sharing a reference, and never mutates the source", () => {
    const source = finished();
    const snapshot = structuredClone(source);
    const clone = buildReplayJob(source, { id: "new-3", now: NOW });
    clone.command.push("--extra");
    expect(source.command).toEqual(["claude", "-p", "continue"]);
    expect(source).toEqual(snapshot);
  });

  it("replays a job in any status the same way (no status is special-cased)", () => {
    for (const status of ["queued", "waiting_for_reset", "resuming", "failed", "cancelled"] as const) {
      const clone = buildReplayJob(finished({ status }), { id: `c-${status}`, now: NOW });
      expect(clone.status).toBe("waiting_for_reset");
      expect(clone.attempts).toBe(0);
    }
  });
});
