import { describe, expect, it } from "vitest";
import {
  canCancel,
  canRequeue,
  canSnooze,
  computeSnoozedResetAt,
  partitionForControl,
  resolveJobId,
} from "../src/control.js";
import type { JobStatus, RelayJob } from "../src/types.js";

function job(id: string, status: JobStatus, resetAt: string | null = null): RelayJob {
  const now = "2026-07-13T00:00:00.000Z";
  return {
    id,
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status,
    resetAt,
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

describe("canSnooze", () => {
  it("allows snoozing only a job that is waiting for a reset", () => {
    expect(canSnooze(job("a", "waiting_for_reset")).ok).toBe(true);
  });

  it("rejects snoozing jobs in any other state with a reason", () => {
    for (const status of ["queued", "resuming", "completed", "failed", "cancelled"] as JobStatus[]) {
      const result = canSnooze(job("a", status));
      expect(result.ok).toBe(false);
      expect(result.reason).toBeTruthy();
    }
  });

  it("explains that a queued job has nothing to defer", () => {
    expect(canSnooze(job("a", "queued")).reason).toContain("not waiting");
  });
});

describe("computeSnoozedResetAt", () => {
  const now = new Date("2026-07-13T00:00:00.000Z");

  it("adds the delay to a future reset time by default", () => {
    const j = job("a", "waiting_for_reset", "2026-07-13T02:00:00.000Z"); // 2h out
    const result = computeSnoozedResetAt(j, 60 * 60_000, now); // +1h
    expect(result).toBe("2026-07-13T03:00:00.000Z");
  });

  it("anchors on now when the current reset is already past", () => {
    const j = job("a", "waiting_for_reset", "2026-07-12T23:00:00.000Z"); // 1h ago
    const result = computeSnoozedResetAt(j, 30 * 60_000, now); // +30m
    // Anchored at now (not the past reset) -> always lands in the future.
    expect(result).toBe("2026-07-13T00:30:00.000Z");
  });

  it("measures from now when fromNow is set, ignoring a later reset", () => {
    const j = job("a", "waiting_for_reset", "2026-07-13T05:00:00.000Z"); // 5h out
    const result = computeSnoozedResetAt(j, 60 * 60_000, now, { fromNow: true }); // +1h from now
    expect(result).toBe("2026-07-13T01:00:00.000Z");
  });

  it("treats a job with no resetAt as anchored at now", () => {
    const j = job("a", "waiting_for_reset", null);
    const result = computeSnoozedResetAt(j, 15 * 60_000, now);
    expect(result).toBe("2026-07-13T00:15:00.000Z");
  });

  it("treats an unparseable resetAt as anchored at now", () => {
    const j = job("a", "waiting_for_reset", "not-a-date");
    const result = computeSnoozedResetAt(j, 15 * 60_000, now);
    expect(result).toBe("2026-07-13T00:15:00.000Z");
  });

  it("always produces a future instant relative to now", () => {
    const j = job("a", "waiting_for_reset", "2026-07-10T00:00:00.000Z"); // days ago
    const result = computeSnoozedResetAt(j, 60_000, now); // +1m
    expect(new Date(result).getTime()).toBeGreaterThan(now.getTime());
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
