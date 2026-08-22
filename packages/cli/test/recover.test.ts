import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FarFutureResetJob, RelayJob, StuckResumingReport } from "@agentrelay/core";
import { RelayQueue } from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recoverFarFutureJobs, recoverJobs } from "../src/commands.js";
import {
  type RecoverFarFutureResult,
  type RecoverResult,
  renderRecover,
  renderRecoverFarFuture,
  renderRecoverFarFutureJson,
  renderRecoverJson,
} from "../src/recover.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");

function report(overrides: Partial<StuckResumingReport> = {}): StuckResumingReport {
  return { total: 0, resuming: 0, stuckAfterMs: 30 * 60_000, stuck: [], ...overrides };
}

function job(overrides: Partial<RelayJob>): RelayJob {
  return {
    id: overrides.id ?? "id",
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status: "resuming",
    resetAt: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("renderRecover", () => {
  it("says nothing is stuck when there are no resuming jobs", () => {
    const result: RecoverResult = { report: report(), recovered: [], dryRun: false };
    expect(renderRecover(result, { now: NOW })).toBe("No jobs are stuck resuming. Nothing to recover.");
  });

  it("notes live resuming jobs within the threshold rather than flagging them", () => {
    const result: RecoverResult = { report: report({ resuming: 1 }), recovered: [], dryRun: false };
    const out = renderRecover(result, { now: NOW });
    expect(out).toContain("No orphaned jobs to recover");
    expect(out).toContain("1 job is resuming");
    expect(out).toContain("left alone");
  });

  it("lists recovered jobs with how long they were stuck", () => {
    const stuck = job({ id: "abcdef12", project: "web", updatedAt: new Date(NOW - 90 * 60_000).toISOString() });
    const result: RecoverResult = {
      report: report({ total: 1, resuming: 1, stuck: [stuck] }),
      recovered: [{ ...stuck, status: "waiting_for_reset" }],
      dryRun: false,
    };
    const out = renderRecover(result, { now: NOW });
    expect(out).toContain("abcdef12");
    expect(out).toContain("web");
    expect(out).toContain("stuck 1h 30m");
    expect(out).toContain("Recovered 1 job");
  });

  it("frames a dry run as a preview that changes nothing", () => {
    const stuck = job({ id: "abcdef12", updatedAt: new Date(NOW - 60 * 60_000).toISOString() });
    const result: RecoverResult = {
      report: report({ total: 1, resuming: 1, stuck: [stuck] }),
      recovered: [],
      dryRun: true,
    };
    const out = renderRecover(result, { now: NOW });
    expect(out).toContain("Would recover 1 job");
    expect(out).toContain("No changes made.");
  });
});

describe("renderRecoverJson", () => {
  it("emits stuck/recovered ids and provenance", () => {
    const stuck = job({ id: "abcdef12" });
    const result: RecoverResult = {
      report: report({ total: 2, resuming: 1, stuck: [stuck] }),
      recovered: [{ ...stuck, status: "waiting_for_reset" }],
      dryRun: false,
    };
    const parsed = JSON.parse(renderRecoverJson(result, "/tmp/jobs.json", "2026-08-15T12:00:00.000Z"));
    expect(parsed).toMatchObject({
      storePath: "/tmp/jobs.json",
      generatedAt: "2026-08-15T12:00:00.000Z",
      dryRun: false,
      resuming: 1,
      total: 2,
      stuck: ["abcdef12"],
      recovered: ["abcdef12"],
    });
  });
});

describe("recoverJobs", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-recover-cli-"));
    storePath = join(dir, "jobs.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Seed a resuming job whose updatedAt is `agoMs` before NOW, written straight to the store. */
  function seedResuming(agoMs: number): string {
    const seeded = job({
      id: "resume01-2222-3333-4444-555566667777",
      status: "resuming",
      updatedAt: new Date(NOW - agoMs).toISOString(),
    });
    writeFileSync(storePath, JSON.stringify([seeded], null, 2), "utf8");
    return seeded.id;
  }

  it("reclaims a stuck resuming job and requeues it due now", () => {
    const id = seedResuming(90 * 60_000);
    const { report: rep, recovered, dryRun } = recoverJobs({ storePath, now: NOW });
    expect(dryRun).toBe(false);
    expect(rep.stuck.map((j) => j.id)).toEqual([id]);
    expect(recovered.map((j) => j.id)).toEqual([id]);

    const after = new RelayQueue(storePath).getById(id);
    expect(after?.status).toBe("waiting_for_reset");
    expect(after?.resetAt).toBe(new Date(NOW).toISOString());
  });

  it("leaves a fresh resuming job alone (a live run)", () => {
    const id = seedResuming(2 * 60_000);
    const { report: rep, recovered } = recoverJobs({ storePath, now: NOW });
    expect(rep.resuming).toBe(1);
    expect(rep.stuck).toEqual([]);
    expect(recovered).toEqual([]);
    expect(new RelayQueue(storePath).getById(id)?.status).toBe("resuming");
  });

  it("dry run reports the stuck job without touching the store", () => {
    const id = seedResuming(90 * 60_000);
    const { recovered, dryRun, report: rep } = recoverJobs({ storePath, dryRun: true, now: NOW });
    expect(dryRun).toBe(true);
    expect(rep.stuck.map((j) => j.id)).toEqual([id]);
    expect(recovered).toEqual([]);
    expect(new RelayQueue(storePath).getById(id)?.status).toBe("resuming");
  });

  it("stuckAfterMs 0 reclaims even a just-started resuming job", () => {
    const id = seedResuming(1_000);
    const { recovered } = recoverJobs({ storePath, stuckAfterMs: 0, now: NOW });
    expect(recovered.map((j) => j.id)).toEqual([id]);
  });
});

const HORIZON = 8 * 24 * 60 * 60_000; // 8 days — DEFAULT_MAX_RESET_HORIZON_MS

function parked(overrides: Partial<FarFutureResetJob> = {}): FarFutureResetJob {
  return {
    id: "id",
    project: "demo",
    resetAt: "2099-01-01T00:00:00.000Z",
    msUntilReset: 100 * 24 * 60 * 60_000,
    ...overrides,
  };
}

describe("renderRecoverFarFuture", () => {
  it("says the guard is disabled when the horizon is null", () => {
    const result: RecoverFarFutureResult = { horizonMs: null, total: 1, parked: [], recovered: [], dryRun: false };
    expect(renderRecoverFarFuture(result, { now: NOW })).toContain("guard is disabled");
  });

  it("says nothing is parked when none exceed the horizon", () => {
    const result: RecoverFarFutureResult = { horizonMs: HORIZON, total: 3, parked: [], recovered: [], dryRun: false };
    const out = renderRecoverFarFuture(result, { now: NOW });
    expect(out).toContain("No jobs are parked with a reset beyond");
    expect(out).toContain("Nothing to recover");
  });

  it("lists soonest-past-horizon first and reports the recovered count", () => {
    const far = parked({ id: "aaaaaaaa", project: "web", msUntilReset: 365 * 24 * 60 * 60_000 });
    const near = parked({ id: "bbbbbbbb", project: "api", msUntilReset: 30 * 24 * 60 * 60_000 });
    const result: RecoverFarFutureResult = {
      horizonMs: HORIZON,
      total: 2,
      parked: [far, near],
      recovered: [{ id: "aaaaaaaa" } as RelayJob, { id: "bbbbbbbb" } as RelayJob],
      dryRun: false,
    };
    const out = renderRecoverFarFuture(result, { now: NOW });
    const lines = out.split("\n");
    // near (30d) sorts before far (365d)
    expect(lines[0]).toContain("bbbbbbbb");
    expect(lines[1]).toContain("aaaaaaaa");
    expect(out).toContain("Recovered 2 jobs");
  });

  it("frames a dry run as a preview that changes nothing", () => {
    const result: RecoverFarFutureResult = {
      horizonMs: HORIZON,
      total: 1,
      parked: [parked({ id: "abcdef12" })],
      recovered: [],
      dryRun: true,
    };
    const out = renderRecoverFarFuture(result, { now: NOW });
    expect(out).toContain("Would recover 1 job");
    expect(out).toContain("No changes made.");
  });
});

describe("renderRecoverFarFutureJson", () => {
  it("emits parked/recovered ids, the horizon, and mode provenance", () => {
    const result: RecoverFarFutureResult = {
      horizonMs: HORIZON,
      total: 2,
      parked: [parked({ id: "abcdef12" })],
      recovered: [{ id: "abcdef12" } as RelayJob],
      dryRun: false,
    };
    const json = JSON.parse(renderRecoverFarFutureJson(result, "/tmp/jobs.json", "2026-08-15T12:00:00.000Z"));
    expect(json).toMatchObject({
      storePath: "/tmp/jobs.json",
      mode: "far-future",
      horizonMs: HORIZON,
      total: 2,
      parked: ["abcdef12"],
      recovered: ["abcdef12"],
    });
  });
});

describe("recoverFarFutureJobs", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-recover-ff-"));
    storePath = join(dir, "jobs.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Seed a waiting_for_reset job whose resetAt is `aheadMs` after NOW. */
  function seedParked(id: string, aheadMs: number, status: RelayJob["status"] = "waiting_for_reset"): string {
    const seeded = job({
      id,
      status,
      attempts: 4,
      resetAt: new Date(NOW + aheadMs).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
    });
    const existing = (() => {
      try {
        return JSON.parse(readFileSync(storePath, "utf8")) as RelayJob[];
      } catch {
        return [];
      }
    })();
    writeFileSync(storePath, JSON.stringify([...existing, seeded], null, 2), "utf8");
    return seeded.id;
  }

  it("requeues a far-future parked job to run now with attempts reset", () => {
    const id = seedParked("ff000001-2222-3333-4444-555566667777", 100 * 24 * 60 * 60_000);
    const result = recoverFarFutureJobs({ storePath, horizonMs: HORIZON, now: NOW });
    expect(result.parked.map((p) => p.id)).toEqual([id]);
    expect(result.recovered.map((j) => j.id)).toEqual([id]);

    const after = new RelayQueue(storePath).getById(id);
    expect(after?.status).toBe("waiting_for_reset");
    expect(after?.resetAt).toBe(new Date(NOW).toISOString());
    expect(after?.attempts).toBe(0);
    expect(after?.lastError).toBeNull();
  });

  it("leaves a near-future parked job (within the horizon) alone", () => {
    const id = seedParked("near0001-2222-3333-4444-555566667777", 2 * 60 * 60_000);
    const result = recoverFarFutureJobs({ storePath, horizonMs: HORIZON, now: NOW });
    expect(result.parked).toEqual([]);
    expect(result.recovered).toEqual([]);
    const after = new RelayQueue(storePath).getById(id);
    expect(after?.resetAt).toBe(new Date(NOW + 2 * 60 * 60_000).toISOString());
  });

  it("dry run reports the parked job without touching the store", () => {
    const id = seedParked("ff000002-2222-3333-4444-555566667777", 100 * 24 * 60 * 60_000);
    const result = recoverFarFutureJobs({ storePath, horizonMs: HORIZON, dryRun: true, now: NOW });
    expect(result.dryRun).toBe(true);
    expect(result.parked.map((p) => p.id)).toEqual([id]);
    expect(result.recovered).toEqual([]);
    expect(new RelayQueue(storePath).getById(id)?.attempts).toBe(4);
  });

  it("guard disabled (horizonMs null) flags and recovers nothing", () => {
    seedParked("ff000003-2222-3333-4444-555566667777", 100 * 24 * 60 * 60_000);
    const result = recoverFarFutureJobs({ storePath, horizonMs: null, now: NOW });
    expect(result.horizonMs).toBeNull();
    expect(result.parked).toEqual([]);
    expect(result.recovered).toEqual([]);
  });

  it("flags a far-future resuming job but does not requeue it (mid-flight guard)", () => {
    const id = seedParked("ff000004-2222-3333-4444-555566667777", 100 * 24 * 60 * 60_000, "resuming");
    const result = recoverFarFutureJobs({ storePath, horizonMs: HORIZON, now: NOW });
    expect(result.parked.map((p) => p.id)).toEqual([id]);
    expect(result.recovered).toEqual([]);
    // Left in place — a live resume must not be raced.
    expect(new RelayQueue(storePath).getById(id)?.status).toBe("resuming");
  });
});
