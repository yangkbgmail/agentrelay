import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FarFutureParkedReport, RelayJob, StuckResumingReport } from "@agentrelay/core";
import { DEFAULT_MAX_RESET_HORIZON_MS, RelayQueue } from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recoverFarFutureJobs, recoverJobs, resolveFarFutureHorizonMs } from "../src/commands.js";
import {
  type RecoverFarFutureRenderResult,
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

const DAY = 24 * 60 * 60_000;

function farReport(overrides: Partial<FarFutureParkedReport> = {}): FarFutureParkedReport {
  return { total: 0, horizonMs: DEFAULT_MAX_RESET_HORIZON_MS, parked: [], ...overrides };
}

describe("renderRecoverFarFuture", () => {
  it("says nothing is parked beyond the horizon when the list is empty", () => {
    const result: RecoverFarFutureRenderResult = { report: farReport(), recovered: [], dryRun: false };
    expect(renderRecoverFarFuture(result, { now: NOW })).toBe(
      "No jobs are parked beyond the 8d 0h reset horizon. Nothing to recover."
    );
  });

  it("dry run lists the parked jobs and their far-future reset without changes", () => {
    const parked = job({
      id: "far01234-5678",
      status: "waiting_for_reset",
      resetAt: new Date(NOW + 100 * DAY).toISOString(),
    });
    const result: RecoverFarFutureRenderResult = {
      report: farReport({ total: 1, parked: [parked] }),
      recovered: [],
      dryRun: true,
    };
    const out = renderRecoverFarFuture(result, { now: NOW });
    expect(out).toContain("far01234");
    expect(out).toContain("resets in 100d");
    expect(out).toContain("Would recover 1 job");
    expect(out).toContain("No changes made.");
  });

  it("real run reports only reclaimed jobs", () => {
    const parked = job({
      id: "far01234-5678",
      status: "waiting_for_reset",
      resetAt: new Date(NOW + 100 * DAY).toISOString(),
    });
    const result: RecoverFarFutureRenderResult = {
      report: farReport({ total: 1, parked: [parked] }),
      recovered: [{ ...parked, status: "waiting_for_reset" }],
      dryRun: false,
    };
    const out = renderRecoverFarFuture(result, { now: NOW });
    expect(out).toContain("Recovered 1 job");
    expect(out).toContain("requeued to resume on the next tick");
  });
});

describe("renderRecoverFarFutureJson", () => {
  it("emits mode/horizon/parked/recovered ids", () => {
    const parked = job({
      id: "far01234-5678",
      status: "waiting_for_reset",
      resetAt: new Date(NOW + 100 * DAY).toISOString(),
    });
    const result: RecoverFarFutureRenderResult = {
      report: farReport({ total: 3, parked: [parked] }),
      recovered: [parked],
      dryRun: false,
    };
    const parsed = JSON.parse(renderRecoverFarFutureJson(result, "/s/jobs.json", "2026-08-15T12:00:00.000Z"));
    expect(parsed.mode).toBe("far-future");
    expect(parsed.horizonMs).toBe(DEFAULT_MAX_RESET_HORIZON_MS);
    expect(parsed.total).toBe(3);
    expect(parsed.parked).toEqual(["far01234-5678"]);
    expect(parsed.recovered).toEqual(["far01234-5678"]);
  });
});

describe("resolveFarFutureHorizonMs", () => {
  it("prefers an explicit override", () => {
    expect(resolveFarFutureHorizonMs(5 * DAY, {})).toBe(5 * DAY);
  });
  it("falls back to the env guard when no override", () => {
    expect(resolveFarFutureHorizonMs(undefined, { AGENTRELAY_MAX_RESET_HORIZON: "2d" })).toBe(2 * DAY);
  });
  it("uses the default when unset", () => {
    expect(resolveFarFutureHorizonMs(undefined, {})).toBe(DEFAULT_MAX_RESET_HORIZON_MS);
  });
  it("uses the default even when the guard is disabled (operator still asked to reclaim)", () => {
    expect(resolveFarFutureHorizonMs(undefined, { AGENTRELAY_MAX_RESET_HORIZON: "off" })).toBe(
      DEFAULT_MAX_RESET_HORIZON_MS
    );
  });
});

describe("recoverFarFutureJobs", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-recover-ff-cli-"));
    storePath = join(dir, "jobs.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Seed a waiting_for_reset job whose resetAt is `aheadMs` after NOW. */
  function seedParked(id: string, aheadMs: number): string {
    const seeded = job({
      id,
      status: "waiting_for_reset",
      resetAt: new Date(NOW + aheadMs).toISOString(),
      attempts: 3,
    });
    const existing = (() => {
      try {
        return new RelayQueue(storePath).listAll();
      } catch {
        return [];
      }
    })();
    writeFileSync(storePath, JSON.stringify([...existing, seeded], null, 2), "utf8");
    return id;
  }

  it("reclaims a far-future parked job and requeues it due now with attempts reset", () => {
    const id = seedParked("far00001-2222-3333-4444-555566667777", 100 * DAY);
    const { report: rep, recovered, dryRun } = recoverFarFutureJobs({ storePath, now: NOW });
    expect(dryRun).toBe(false);
    expect(rep.parked.map((j) => j.id)).toEqual([id]);
    expect(recovered.map((j) => j.id)).toEqual([id]);
    const after = new RelayQueue(storePath).getById(id);
    expect(after?.status).toBe("waiting_for_reset");
    expect(after?.attempts).toBe(0); // requeueNow resets attempts (the parked one was a misparse)
    expect(Date.parse(after?.resetAt ?? "")).toBeLessThanOrEqual(NOW + 1_000); // due now
  });

  it("leaves a near-future parked job alone", () => {
    const id = seedParked("near0001-2222-3333-4444-555566667777", 2 * DAY);
    const { recovered } = recoverFarFutureJobs({ storePath, now: NOW });
    expect(recovered).toEqual([]);
    expect(new RelayQueue(storePath).getById(id)?.status).toBe("waiting_for_reset");
  });

  it("dry run reports the parked job without touching the store", () => {
    const id = seedParked("far00001-2222-3333-4444-555566667777", 100 * DAY);
    const { recovered, dryRun, report: rep } = recoverFarFutureJobs({ storePath, dryRun: true, now: NOW });
    expect(dryRun).toBe(true);
    expect(rep.parked.map((j) => j.id)).toEqual([id]);
    expect(recovered).toEqual([]);
    expect(new RelayQueue(storePath).getById(id)?.attempts).toBe(3); // untouched
  });

  it("a tighter --horizon reclaims a job the default would leave parked", () => {
    const id = seedParked("mid00001-2222-3333-4444-555566667777", 6 * DAY);
    // Default 8d horizon leaves a 6d reset alone; a 5d horizon reclaims it.
    expect(recoverFarFutureJobs({ storePath, now: NOW }).recovered).toEqual([]);
    const { recovered } = recoverFarFutureJobs({ storePath, horizonMs: 5 * DAY, now: NOW });
    expect(recovered.map((j) => j.id)).toEqual([id]);
  });
});
