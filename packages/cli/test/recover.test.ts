import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FarFutureParkedReport, RelayJob, StuckResumingReport } from "@agentrelay/core";
import { DEFAULT_MAX_RESET_HORIZON_MS, RelayQueue } from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recoverJobs } from "../src/commands.js";
import { type RecoverResult, renderRecover, renderRecoverJson } from "../src/recover.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");

function report(overrides: Partial<StuckResumingReport> = {}): StuckResumingReport {
  return { total: 0, resuming: 0, stuckAfterMs: 30 * 60_000, stuck: [], ...overrides };
}

function farReport(overrides: Partial<FarFutureParkedReport> = {}): FarFutureParkedReport {
  return { total: 0, waiting: 0, horizonMs: DEFAULT_MAX_RESET_HORIZON_MS, parked: [], ...overrides };
}

const DAY = 24 * 60 * 60_000;

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

  it("appends a far-future section listing reclaimed misparsed jobs", () => {
    const parked = job({
      id: "far00001",
      project: "web",
      status: "waiting_for_reset",
      resetAt: new Date(NOW + 30 * DAY).toISOString(),
    });
    const result: RecoverResult = {
      report: report(),
      recovered: [],
      dryRun: false,
      farFuture: {
        report: farReport({ total: 1, waiting: 1, parked: [parked] }),
        recovered: [{ ...parked, resetAt: new Date(NOW).toISOString() }],
      },
    };
    const out = renderRecover(result, { now: NOW });
    expect(out).toContain("Far-future parked jobs");
    expect(out).toContain("far00001");
    expect(out).toContain("reset 30d 0h out");
    expect(out).toContain("Recovered 1 misparsed job");
  });

  it("far-future section says the queue is clean when nothing is parked far out", () => {
    const result: RecoverResult = {
      report: report(),
      recovered: [],
      dryRun: false,
      farFuture: { report: farReport({ waiting: 3 }), recovered: [] },
    };
    const out = renderRecover(result, { now: NOW });
    expect(out).toContain("Far-future parked jobs");
    expect(out).toContain("Nothing to recover");
  });

  it("far-future section notes when the horizon guard is disabled", () => {
    const result: RecoverResult = {
      report: report(),
      recovered: [],
      dryRun: false,
      farFuture: { report: farReport({ horizonMs: null }), recovered: [] },
    };
    const out = renderRecover(result, { now: NOW });
    expect(out).toContain("guard is disabled");
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
    // No far-future key unless the scan was requested.
    expect(parsed.farFuture).toBeUndefined();
  });

  it("includes the far-future scan when present", () => {
    const parked = job({ id: "far00001", status: "waiting_for_reset" });
    const result: RecoverResult = {
      report: report({ total: 1 }),
      recovered: [],
      dryRun: false,
      farFuture: { report: farReport({ total: 1, waiting: 1, parked: [parked] }), recovered: [parked] },
    };
    const parsed = JSON.parse(renderRecoverJson(result, "/tmp/jobs.json", "2026-08-15T12:00:00.000Z"));
    expect(parsed.farFuture).toMatchObject({
      horizonMs: DEFAULT_MAX_RESET_HORIZON_MS,
      waiting: 1,
      parked: ["far00001"],
      recovered: ["far00001"],
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

  /** Seed a parked job whose reset is `inMs` after NOW, written straight to the store. */
  function seedParked(id: string, inMs: number): string {
    const seeded = job({
      id,
      status: "waiting_for_reset",
      resetAt: new Date(NOW + inMs).toISOString(),
      attempts: 3,
      lastError: "rate limited",
      updatedAt: new Date(NOW - 60_000).toISOString(),
    });
    writeFileSync(storePath, JSON.stringify([seeded], null, 2), "utf8");
    return seeded.id;
  }

  it("does not scan for far-future jobs unless opted in", () => {
    const id = seedParked("far00001-2222-3333-4444-555566667777", 100 * DAY);
    const { farFuture } = recoverJobs({ storePath, now: NOW });
    expect(farFuture).toBeUndefined();
    // The misparsed job is left parked far out.
    expect(new RelayQueue(storePath).getById(id)?.status).toBe("waiting_for_reset");
  });

  it("with --far-future requeues a misparsed parked job to run now (attempts reset)", () => {
    const id = seedParked("far00001-2222-3333-4444-555566667777", 100 * DAY);
    const { farFuture } = recoverJobs({
      storePath,
      farFuture: true,
      horizonMs: DEFAULT_MAX_RESET_HORIZON_MS,
      now: NOW,
    });
    expect(farFuture?.report.parked.map((j) => j.id)).toEqual([id]);
    expect(farFuture?.recovered.map((j) => j.id)).toEqual([id]);

    const after = new RelayQueue(storePath).getById(id);
    expect(after?.status).toBe("waiting_for_reset");
    expect(after?.resetAt).toBe(new Date(NOW).toISOString());
    expect(after?.attempts).toBe(0); // requeueNow gives it a fresh retry
    expect(after?.lastError).toBeNull();
  });

  it("--far-future dry run reports the parked job without touching the store", () => {
    const id = seedParked("far00001-2222-3333-4444-555566667777", 100 * DAY);
    const { farFuture } = recoverJobs({
      storePath,
      farFuture: true,
      dryRun: true,
      horizonMs: DEFAULT_MAX_RESET_HORIZON_MS,
      now: NOW,
    });
    expect(farFuture?.report.parked.map((j) => j.id)).toEqual([id]);
    expect(farFuture?.recovered).toEqual([]);
    const after = new RelayQueue(storePath).getById(id);
    expect(after?.resetAt).toBe(new Date(NOW + 100 * DAY).toISOString());
  });

  it("--far-future leaves a near-reset parked job alone", () => {
    const id = seedParked("near0001-2222-3333-4444-555566667777", 2 * 60 * 60_000);
    const { farFuture } = recoverJobs({
      storePath,
      farFuture: true,
      horizonMs: DEFAULT_MAX_RESET_HORIZON_MS,
      now: NOW,
    });
    expect(farFuture?.report.parked).toEqual([]);
    expect(new RelayQueue(storePath).getById(id)?.resetAt).toBe(new Date(NOW + 2 * 60 * 60_000).toISOString());
  });

  it("--far-future with the guard disabled (null horizon) reclaims nothing", () => {
    const id = seedParked("far00001-2222-3333-4444-555566667777", 365 * DAY);
    const { farFuture } = recoverJobs({ storePath, farFuture: true, horizonMs: null, now: NOW });
    expect(farFuture?.report.horizonMs).toBeNull();
    expect(farFuture?.recovered).toEqual([]);
    expect(new RelayQueue(storePath).getById(id)?.resetAt).toBe(new Date(NOW + 365 * DAY).toISOString());
  });
});
