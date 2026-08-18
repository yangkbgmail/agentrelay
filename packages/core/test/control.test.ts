import { describe, expect, it } from "vitest";
import {
  canCancel,
  canRequeue,
  canReschedule,
  partitionForControl,
  resolveJobId,
  resolveRescheduleTime,
} from "../src/control.js";
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

describe("canReschedule", () => {
  it("allows rescheduling still-pending jobs", () => {
    for (const status of ["queued", "waiting_for_reset"] as JobStatus[]) {
      expect(canReschedule(job("a", status)).ok).toBe(true);
    }
  });

  it("rejects a job that is currently resuming", () => {
    const result = canReschedule(job("a", "resuming"));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("resuming");
  });

  it("rejects terminal jobs and points them at retry", () => {
    for (const status of ["completed", "failed", "cancelled"] as JobStatus[]) {
      const result = canReschedule(job("a", status));
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/retry/);
    }
  });
});

describe("resolveRescheduleTime", () => {
  const now = new Date("2026-08-18T12:00:00.000Z");

  it("resolves `now` (case-insensitive) to the current instant", () => {
    expect(resolveRescheduleTime("now", now)).toEqual({ at: now.toISOString() });
    expect(resolveRescheduleTime("  NOW ", now)).toEqual({ at: now.toISOString() });
  });

  it("adds a signed relative offset to now", () => {
    expect(resolveRescheduleTime("+2h", now)).toEqual({ at: "2026-08-18T14:00:00.000Z" });
    expect(resolveRescheduleTime("+30m", now)).toEqual({ at: "2026-08-18T12:30:00.000Z" });
  });

  it("treats a bare (unsigned) duration as a future offset", () => {
    expect(resolveRescheduleTime("45m", now)).toEqual({ at: "2026-08-18T12:45:00.000Z" });
    expect(resolveRescheduleTime("1d", now)).toEqual({ at: "2026-08-19T12:00:00.000Z" });
  });

  it("allows a negative offset (lands in the past → due immediately)", () => {
    expect(resolveRescheduleTime("-15m", now)).toEqual({ at: "2026-08-18T11:45:00.000Z" });
  });

  it("accepts an absolute ISO timestamp and normalises it", () => {
    expect(resolveRescheduleTime("2026-08-18T15:00:00Z", now)).toEqual({ at: "2026-08-18T15:00:00.000Z" });
  });

  it("errors on empty input", () => {
    const result = resolveRescheduleTime("   ", now);
    expect(result.at).toBeUndefined();
    expect(result.error).toBeTruthy();
  });

  it("errors on unparseable input", () => {
    const result = resolveRescheduleTime("whenever", now);
    expect(result.at).toBeUndefined();
    expect(result.error).toContain("could not parse");
  });

  it("rejects an unknown duration unit rather than misparsing it", () => {
    // 'y' (years) is not a supported unit and is not a valid Date either.
    const result = resolveRescheduleTime("2y", now);
    expect(result.at).toBeUndefined();
    expect(result.error).toBeTruthy();
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
