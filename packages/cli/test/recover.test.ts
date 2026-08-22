import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FarFutureParkedReport, RelayJob, StuckResumingReport } from "@agentrelay/core";
import { RelayQueue } from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recoverJobs } from "../src/commands.js";
import { type RecoverResult, renderRecover, renderRecoverJson } from "../src/recover.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const HORIZON = 8 * 24 * 60 * 60_000;
const DAY = 24 * 60 * 60_000;

function report(overrides: Partial<StuckResumingReport> = {}): StuckResumingReport {
  return { total: 0, resuming: 0, stuckAfterMs: 30 * 60_000, stuck: [], ...overrides };
}

function farReport(overrides: Partial<FarFutureParkedReport> = {}): FarFutureParkedReport {
  return { total: 0, parked: 0, horizonMs: HORIZON, farFuture: [], ...overrides };
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
    expect(out).toContain("Recovered 1 orphaned job");
  });

  it("frames a dry run as a preview that changes nothing", () => {
    const stuck = job({ id: "abcdef12", updatedAt: new Date(NOW - 60 * 60_000).toISOString() });
    const result: RecoverResult = {
      report: report({ total: 1, resuming: 1, stuck: [stuck] }),
      recovered: [],
      dryRun: true,
    };
    const out = renderRecover(result, { now: NOW });
    expect(out).toContain("Would recover 1 orphaned job");
    expect(out).toContain("No changes made.");
  });

  it("lists reclaimed far-future parked jobs with how far out they were set", () => {
    const parked = job({
      id: "far12345",
      project: "api",
      status: "waiting_for_reset",
      resetAt: new Date(NOW + 100 * DAY).toISOString(),
    });
    const result: RecoverResult = {
      report: report(),
      recovered: [],
      farFutureReport: farReport({ total: 1, parked: 1, farFuture: [parked] }),
      farFutureRecovered: [{ ...parked, resetAt: new Date(NOW).toISOString() }],
      dryRun: false,
    };
    const out = renderRecover(result, { now: NOW });
    expect(out).toContain("far12345");
    expect(out).toContain("api");
    expect(out).toContain("reset in 100d");
    expect(out).toContain("Recovered 1 far-future job");
  });

  it("notes a disabled far-future guard when nothing else is reclaimable", () => {
    const result: RecoverResult = {
      report: report(),
      recovered: [],
      farFutureReport: farReport({ horizonMs: null, parked: 1 }),
      farFutureRecovered: [],
      dryRun: false,
    };
    const out = renderRecover(result, { now: NOW });
    expect(out).toContain("Far-future guard is disabled");
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
    // No far-future block unless requested.
    expect(parsed.farFuture).toBeUndefined();
  });

  it("includes a farFuture block only when far-future was requested", () => {
    const parked = job({ id: "far12345", status: "waiting_for_reset" });
    const result: RecoverResult = {
      report: report({ total: 1 }),
      recovered: [],
      farFutureReport: farReport({ total: 1, parked: 1, farFuture: [parked] }),
      farFutureRecovered: [parked],
      dryRun: false,
    };
    const parsed = JSON.parse(renderRecoverJson(result, "/tmp/jobs.json", "2026-08-15T12:00:00.000Z"));
    expect(parsed.farFuture).toEqual({
      horizonMs: HORIZON,
      parked: 1,
      stuck: ["far12345"],
      recovered: ["far12345"],
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

  /** Seed a parked (waiting_for_reset) job whose reset is `aheadMs` after NOW. */
  function seedParked(aheadMs: number, attempts = 2): string {
    const seeded = job({
      id: "parked01-2222-3333-4444-555566667777",
      status: "waiting_for_reset",
      resetAt: new Date(NOW + aheadMs).toISOString(),
      attempts,
      lastError: "usage limit reached",
    });
    writeFileSync(storePath, JSON.stringify([seeded], null, 2), "utf8");
    return seeded.id;
  }

  it("leaves far-future parked jobs untouched unless --far-future is set", () => {
    const id = seedParked(100 * DAY);
    const { report: rep, farFutureReport } = recoverJobs({ storePath, now: NOW });
    expect(rep.stuck).toEqual([]);
    expect(farFutureReport).toBeUndefined();
    expect(new RelayQueue(storePath).getById(id)?.status).toBe("waiting_for_reset");
  });

  it("with farFuture reclaims a far-future parked job via requeueNow (fresh attempts)", () => {
    const id = seedParked(100 * DAY, 3);
    const { farFutureReport, farFutureRecovered, dryRun } = recoverJobs({
      storePath,
      farFuture: true,
      horizonMs: HORIZON,
      now: NOW,
    });
    expect(dryRun).toBe(false);
    expect(farFutureReport?.farFuture.map((j) => j.id)).toEqual([id]);
    expect(farFutureRecovered?.map((j) => j.id)).toEqual([id]);

    const after = new RelayQueue(storePath).getById(id);
    expect(after?.status).toBe("waiting_for_reset");
    expect(after?.resetAt).toBe(new Date(NOW).toISOString()); // due now
    expect(after?.attempts).toBe(0); // requeueNow resets the budget — the park never ran
    expect(after?.lastError).toBeNull();
  });

  it("with farFuture leaves a near-future parked job alone", () => {
    const id = seedParked(2 * 60 * 60_000); // 2h out — plausible
    const { farFutureReport, farFutureRecovered } = recoverJobs({
      storePath,
      farFuture: true,
      horizonMs: HORIZON,
      now: NOW,
    });
    expect(farFutureReport?.parked).toBe(1);
    expect(farFutureReport?.farFuture).toEqual([]);
    expect(farFutureRecovered).toEqual([]);
    const after = new RelayQueue(storePath).getById(id);
    expect(after?.resetAt).toBe(new Date(NOW + 2 * 60 * 60_000).toISOString()); // unchanged
  });

  it("far-future dry run reports without touching the store", () => {
    const id = seedParked(100 * DAY, 3);
    const { farFutureReport, farFutureRecovered, dryRun } = recoverJobs({
      storePath,
      farFuture: true,
      horizonMs: HORIZON,
      dryRun: true,
      now: NOW,
    });
    expect(dryRun).toBe(true);
    expect(farFutureReport?.farFuture.map((j) => j.id)).toEqual([id]);
    expect(farFutureRecovered).toEqual([]);
    const after = new RelayQueue(storePath).getById(id);
    expect(after?.attempts).toBe(3); // untouched
    expect(after?.resetAt).toBe(new Date(NOW + 100 * DAY).toISOString());
  });

  it("with a disabled horizon reclaims nothing on the far-future path", () => {
    const id = seedParked(100 * DAY);
    const { farFutureReport, farFutureRecovered } = recoverJobs({
      storePath,
      farFuture: true,
      horizonMs: null,
      now: NOW,
    });
    expect(farFutureReport?.horizonMs).toBeNull();
    expect(farFutureReport?.farFuture).toEqual([]);
    expect(farFutureRecovered).toEqual([]);
    expect(new RelayQueue(storePath).getById(id)?.attempts).toBe(2); // unchanged
  });
});
