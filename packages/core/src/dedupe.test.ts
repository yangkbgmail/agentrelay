import { describe, expect, it } from "vitest";
import { DEDUPE_STATUSES, dedupeKey, planDedupe } from "./dedupe.js";
import type { RelayJob } from "./types.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${String(seq).padStart(3, "0")}`,
    project: "alpha",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/repo/alpha",
    status: "waiting_for_reset",
    resetAt: "2026-07-30T09:00:00.000Z",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("dedupeKey", () => {
  it("is equal for same tool + cwd + command", () => {
    expect(dedupeKey(job())).toBe(dedupeKey(job()));
  });

  it("differs when the command argv differs", () => {
    expect(dedupeKey(job({ command: ["claude", "-p", "go"] }))).not.toBe(
      dedupeKey(job({ command: ["claude", "-p", "stop"] }))
    );
  });

  it("differs when cwd or tool differs", () => {
    const base = job();
    expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, cwd: "/other" }));
    expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, tool: "codex-cli" }));
  });

  it("does not confuse a single joined arg with separate args", () => {
    expect(dedupeKey(job({ command: ["claude", "-p go"] }))).not.toBe(
      dedupeKey(job({ command: ["claude", "-p", "go"] }))
    );
  });
});

describe("planDedupe", () => {
  it("returns an empty plan for an empty store", () => {
    expect(planDedupe([])).toEqual({ groups: [], duplicateCount: 0, scannedCount: 0 });
  });

  it("finds no duplicates when every active job is distinct", () => {
    const plan = planDedupe([job({ command: ["claude", "-p", "a"] }), job({ command: ["claude", "-p", "b"] })]);
    expect(plan.groups).toHaveLength(0);
    expect(plan.duplicateCount).toBe(0);
    expect(plan.scannedCount).toBe(2);
  });

  it("groups identical active jobs and keeps exactly one", () => {
    const a = job({ id: "aaa" });
    const b = job({ id: "bbb" });
    const c = job({ id: "ccc" });
    const plan = planDedupe([a, b, c]);
    expect(plan.groups).toHaveLength(1);
    expect(plan.duplicateCount).toBe(2);
    expect(plan.groups[0].keep).toBeDefined();
    expect(plan.groups[0].duplicates).toHaveLength(2);
    // keeper + duplicates together are exactly the input set.
    const seen = [plan.groups[0].keep, ...plan.groups[0].duplicates].map((j) => j.id).sort();
    expect(seen).toEqual(["aaa", "bbb", "ccc"]);
  });

  it("keeps the soonest-resuming job (queued/null resetAt wins over a future reset)", () => {
    const future = job({ id: "future", status: "waiting_for_reset", resetAt: "2026-07-30T12:00:00.000Z" });
    const dueNow = job({ id: "due", status: "queued", resetAt: null });
    const plan = planDedupe([future, dueNow]);
    expect(plan.groups[0].keep.id).toBe("due");
    expect(plan.groups[0].duplicates.map((j) => j.id)).toEqual(["future"]);
  });

  it("tie-breaks equal reset times by newest createdAt then id", () => {
    const older = job({ id: "older", createdAt: "2026-07-30T00:00:00.000Z" });
    const newer = job({ id: "newer", createdAt: "2026-07-30T05:00:00.000Z" });
    const plan = planDedupe([older, newer]);
    expect(plan.groups[0].keep.id).toBe("newer");
  });

  it("never prefers a job with an unparseable resetAt as the keeper", () => {
    const broken = job({ id: "broken", resetAt: "not-a-date" });
    const good = job({ id: "good", resetAt: "2026-07-30T09:00:00.000Z" });
    const plan = planDedupe([broken, good]);
    expect(plan.groups[0].keep.id).toBe("good");
    expect(plan.groups[0].duplicates.map((j) => j.id)).toEqual(["broken"]);
  });

  it("ignores terminal and resuming jobs by default", () => {
    const plan = planDedupe([
      job({ id: "q1", status: "queued" }),
      job({ id: "q2", status: "queued" }),
      job({ id: "done", status: "completed" }),
      job({ id: "gone", status: "cancelled" }),
      job({ id: "inflight", status: "resuming" }),
      job({ id: "dead", status: "failed" }),
    ]);
    expect(plan.scannedCount).toBe(2);
    expect(plan.duplicateCount).toBe(1);
    expect([plan.groups[0].keep, ...plan.groups[0].duplicates].map((j) => j.id).sort()).toEqual(["q1", "q2"]);
  });

  it("can widen the active set via options.statuses", () => {
    const plan = planDedupe([job({ id: "r1", status: "resuming" }), job({ id: "r2", status: "resuming" })], {
      statuses: [...DEDUPE_STATUSES, "resuming"],
    });
    expect(plan.duplicateCount).toBe(1);
  });

  it("reports multiple groups ordered by duplicate count (biggest first)", () => {
    const plan = planDedupe([
      // group A: 3 copies (2 duplicates)
      job({ id: "a1", command: ["claude", "-p", "A"] }),
      job({ id: "a2", command: ["claude", "-p", "A"] }),
      job({ id: "a3", command: ["claude", "-p", "A"] }),
      // group B: 2 copies (1 duplicate)
      job({ id: "b1", command: ["claude", "-p", "B"] }),
      job({ id: "b2", command: ["claude", "-p", "B"] }),
    ]);
    expect(plan.groups).toHaveLength(2);
    expect(plan.groups[0].duplicates).toHaveLength(2);
    expect(plan.groups[1].duplicates).toHaveLength(1);
    expect(plan.duplicateCount).toBe(3);
  });

  it("does not mutate the input list", () => {
    const jobs = [job({ id: "x1" }), job({ id: "x2" })];
    const before = jobs.map((j) => j.id);
    planDedupe(jobs);
    expect(jobs.map((j) => j.id)).toEqual(before);
  });
});
