import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FarFutureResetJob, RelayJob, StuckResumingReport } from "@agentrelay/core";
import { RelayQueue } from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recoverFarFutureResets, recoverJobs } from "../src/commands.js";
import {
  type FarFutureRecoverResult,
  type RecoverResult,
  renderFarFutureRecover,
  renderFarFutureRecoverJson,
  renderRecover,
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

const DAY_MS = 24 * 60 * 60_000;

function farJob(overrides: Partial<FarFutureResetJob> = {}): FarFutureResetJob {
  return {
    id: overrides.id ?? "aaaaaaaa-1111-2222-3333-444455556666",
    project: overrides.project ?? "web",
    resetAt: overrides.resetAt ?? new Date(NOW + 100 * DAY_MS).toISOString(),
    msUntilReset: overrides.msUntilReset ?? 100 * DAY_MS,
  };
}

describe("renderFarFutureRecover", () => {
  it("explains the guard being disabled as a quiet success", () => {
    const result: FarFutureRecoverResult = { horizonMs: null, farFuture: [], reclaimed: [], dryRun: false };
    const out = renderFarFutureRecover(result);
    expect(out).toContain("guard is disabled");
    expect(out).toContain("Nothing to reclaim");
  });

  it("says nothing is parked far in the future when the queue is clean", () => {
    const result: FarFutureRecoverResult = {
      horizonMs: 8 * DAY_MS,
      farFuture: [],
      reclaimed: [],
      dryRun: false,
    };
    expect(renderFarFutureRecover(result)).toContain("No jobs are parked beyond");
  });

  it("lists reclaimed far-future jobs with how far ahead their reset was", () => {
    const far = farJob({ id: "abcdef12-9999", project: "web", msUntilReset: 100 * DAY_MS });
    const result: FarFutureRecoverResult = {
      horizonMs: 8 * DAY_MS,
      farFuture: [far],
      reclaimed: [job({ id: far.id, status: "waiting_for_reset" })],
      dryRun: false,
    };
    const out = renderFarFutureRecover(result);
    expect(out).toContain("abcdef12");
    expect(out).toContain("web");
    expect(out).toContain("reset in");
    expect(out).toContain("Reclaimed 1 job");
  });

  it("frames a dry run as a preview that changes nothing", () => {
    const result: FarFutureRecoverResult = {
      horizonMs: 8 * DAY_MS,
      farFuture: [farJob()],
      reclaimed: [],
      dryRun: true,
    };
    const out = renderFarFutureRecover(result);
    expect(out).toContain("Would reclaim 1 job");
    expect(out).toContain("No changes made.");
  });
});

describe("renderFarFutureRecoverJson", () => {
  it("emits the horizon, far-future jobs, and reclaimed ids", () => {
    const far = farJob({ id: "abcdef12-9999" });
    const result: FarFutureRecoverResult = {
      horizonMs: 8 * DAY_MS,
      farFuture: [far],
      reclaimed: [job({ id: far.id, status: "waiting_for_reset" })],
      dryRun: false,
    };
    const parsed = JSON.parse(renderFarFutureRecoverJson(result, "/tmp/jobs.json", "2026-08-15T12:00:00.000Z"));
    expect(parsed).toMatchObject({
      storePath: "/tmp/jobs.json",
      mode: "reset-horizon",
      dryRun: false,
      horizonMs: 8 * DAY_MS,
      reclaimed: ["abcdef12-9999"],
    });
    expect(parsed.farFuture[0]).toMatchObject({ id: "abcdef12-9999", msUntilReset: 100 * DAY_MS });
  });
});

describe("recoverFarFutureResets", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-recover-far-"));
    storePath = join(dir, "jobs.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Seed a waiting_for_reset job whose resetAt is `aheadMs` after NOW. */
  function seedParked(id: string, aheadMs: number): void {
    const seeded = job({
      id,
      status: "waiting_for_reset",
      resetAt: new Date(NOW + aheadMs).toISOString(),
      attempts: 2,
    });
    const existing = existsSyncRead(storePath);
    writeFileSync(storePath, JSON.stringify([...existing, seeded], null, 2), "utf8");
  }

  function existsSyncRead(p: string): RelayJob[] {
    try {
      return JSON.parse(readFileSync(p, "utf8")) as RelayJob[];
    } catch {
      return [];
    }
  }

  it("reclaims a far-future parked job, requeuing it due now with fresh attempts", () => {
    const id = "far00001-1111-2222-3333-444455556666";
    seedParked(id, 100 * DAY_MS);
    const result = recoverFarFutureResets({ storePath, now: NOW, env: {} });
    expect(result.horizonMs).not.toBeNull();
    expect(result.farFuture.map((j) => j.id)).toEqual([id]);
    expect(result.reclaimed.map((j) => j.id)).toEqual([id]);

    const after = new RelayQueue(storePath).getById(id);
    expect(after?.status).toBe("waiting_for_reset");
    expect(after?.resetAt).toBe(new Date(NOW).toISOString());
    expect(after?.attempts).toBe(0);
  });

  it("leaves a near-future parked job alone", () => {
    const id = "near0001-1111-2222-3333-444455556666";
    seedParked(id, 2 * 60 * 60_000); // 2h ahead — well within the horizon
    const result = recoverFarFutureResets({ storePath, now: NOW, env: {} });
    expect(result.farFuture).toEqual([]);
    expect(result.reclaimed).toEqual([]);
    expect(new RelayQueue(storePath).getById(id)?.resetAt).toBe(new Date(NOW + 2 * 60 * 60_000).toISOString());
  });

  it("orders far-future jobs earliest reset first", () => {
    const a = "aaaa0001-1111-2222-3333-444455556666";
    const b = "bbbb0001-1111-2222-3333-444455556666";
    seedParked(a, 300 * DAY_MS);
    seedParked(b, 50 * DAY_MS);
    const result = recoverFarFutureResets({ storePath, dryRun: true, now: NOW, env: {} });
    expect(result.farFuture.map((j) => j.id)).toEqual([b, a]);
    // Dry run touched nothing.
    expect(result.reclaimed).toEqual([]);
    expect(new RelayQueue(storePath).getById(a)?.attempts).toBe(2);
  });

  it("reclaims nothing when the reset-horizon guard is disabled", () => {
    const id = "off00001-1111-2222-3333-444455556666";
    seedParked(id, 100 * DAY_MS);
    const result = recoverFarFutureResets({ storePath, now: NOW, env: { AGENTRELAY_MAX_RESET_HORIZON: "off" } });
    expect(result.horizonMs).toBeNull();
    expect(result.farFuture).toEqual([]);
    expect(result.reclaimed).toEqual([]);
    expect(new RelayQueue(storePath).getById(id)?.attempts).toBe(2);
  });
});
