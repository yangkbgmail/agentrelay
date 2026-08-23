import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FarFutureParkedReport, RelayJob, StrandedResetReport, StuckResumingReport } from "@agentrelay/core";
import { RelayQueue } from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recoverJobs } from "../src/commands.js";
import { type RecoverResult, renderRecover, renderRecoverJson } from "../src/recover.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");

function report(overrides: Partial<StuckResumingReport> = {}): StuckResumingReport {
  return { total: 0, resuming: 0, stuckAfterMs: 30 * 60_000, stuck: [], ...overrides };
}

const DAY = 24 * 60 * 60_000;
const HORIZON = 8 * DAY;

function ffReport(overrides: Partial<FarFutureParkedReport> = {}): FarFutureParkedReport {
  return { total: 0, parked: 0, horizonMs: HORIZON, farFuture: [], ...overrides };
}

function strReport(overrides: Partial<StrandedResetReport> = {}): StrandedResetReport {
  return { total: 0, waiting: 0, stranded: [], ...overrides };
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

  it("appends a far-future section listing reclaimed parked jobs with reset distance", () => {
    const parked = job({
      id: "far00001",
      project: "web",
      status: "waiting_for_reset",
      resetAt: new Date(NOW + 100 * DAY).toISOString(),
    });
    const result: RecoverResult = {
      report: report(),
      recovered: [],
      farFuture: {
        report: ffReport({ total: 1, parked: 1, farFuture: [parked] }),
        recovered: [{ ...parked }],
      },
      dryRun: false,
    };
    const out = renderRecover(result, { now: NOW });
    expect(out).toContain("far00001");
    expect(out).toContain("resets in 100d");
    expect(out).toContain("Recovered 1 far-future parked job");
  });

  it("far-future block says there's nothing to recover within the horizon", () => {
    const result: RecoverResult = {
      report: report(),
      recovered: [],
      farFuture: { report: ffReport({ parked: 3 }), recovered: [] },
      dryRun: false,
    };
    const out = renderRecover(result, { now: NOW });
    expect(out).toContain("No far-future parked jobs to recover");
    expect(out).toContain("3 parked jobs");
  });

  it("far-future block notes when the horizon guard is disabled", () => {
    const result: RecoverResult = {
      report: report(),
      recovered: [],
      farFuture: { report: ffReport({ horizonMs: null }), recovered: [] },
      dryRun: false,
    };
    expect(renderRecover(result, { now: NOW })).toContain("reset-horizon guard is disabled");
  });

  it("appends a stranded section listing reclaimed jobs with why they had no reset", () => {
    const nullReset = job({
      id: "strand01",
      project: "web",
      status: "waiting_for_reset",
      resetAt: null,
      createdAt: new Date(NOW - 2 * DAY).toISOString(),
    });
    const badReset = job({
      id: "strand02",
      project: "api",
      status: "waiting_for_reset",
      resetAt: "not-a-date",
      createdAt: new Date(NOW - DAY).toISOString(),
    });
    const result: RecoverResult = {
      report: report(),
      recovered: [],
      stranded: {
        report: strReport({ total: 2, waiting: 2, stranded: [nullReset, badReset] }),
        recovered: [{ ...nullReset }, { ...badReset }],
      },
      dryRun: false,
    };
    const out = renderRecover(result, { now: NOW });
    expect(out).toContain("strand01");
    expect(out).toContain("no resetAt");
    expect(out).toContain('bad resetAt "not-a-date"');
    expect(out).toContain("stranded 2d 0h");
    expect(out).toContain("Recovered 2 stranded jobs");
  });

  it("stranded block says there's nothing to recover when every waiting job has a reset", () => {
    const result: RecoverResult = {
      report: report(),
      recovered: [],
      stranded: { report: strReport({ waiting: 3 }), recovered: [] },
      dryRun: false,
    };
    const out = renderRecover(result, { now: NOW });
    expect(out).toContain("No stranded jobs to recover");
    expect(out).toContain("3 waiting jobs");
  });

  it("frames a stranded dry run as a preview that changes nothing", () => {
    const nullReset = job({ id: "strand03", status: "waiting_for_reset", resetAt: null });
    const result: RecoverResult = {
      report: report(),
      recovered: [],
      stranded: { report: strReport({ total: 1, waiting: 1, stranded: [nullReset] }), recovered: [] },
      dryRun: true,
    };
    const out = renderRecover(result, { now: NOW });
    expect(out).toContain("Would recover 1 stranded job");
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
    expect(parsed.farFuture).toBeUndefined();
  });

  it("includes a farFuture block only when the far-future scope was requested", () => {
    const parked = job({ id: "far00001", status: "waiting_for_reset" });
    const result: RecoverResult = {
      report: report(),
      recovered: [],
      farFuture: {
        report: ffReport({ parked: 1, farFuture: [parked] }),
        recovered: [{ ...parked }],
      },
      dryRun: false,
    };
    const parsed = JSON.parse(renderRecoverJson(result, "/tmp/jobs.json", "2026-08-15T12:00:00.000Z"));
    expect(parsed.farFuture).toMatchObject({
      horizonMs: HORIZON,
      parked: 1,
      stuck: ["far00001"],
      recovered: ["far00001"],
    });
    expect(parsed.stranded).toBeUndefined();
  });

  it("includes a stranded block only when the stranded scope was requested", () => {
    const strand = job({ id: "strand01", status: "waiting_for_reset", resetAt: null });
    const result: RecoverResult = {
      report: report(),
      recovered: [],
      stranded: {
        report: strReport({ waiting: 1, stranded: [strand] }),
        recovered: [{ ...strand }],
      },
      dryRun: false,
    };
    const parsed = JSON.parse(renderRecoverJson(result, "/tmp/jobs.json", "2026-08-15T12:00:00.000Z"));
    expect(parsed.stranded).toMatchObject({
      waiting: 1,
      stuck: ["strand01"],
      recovered: ["strand01"],
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

  /** Seed a waiting_for_reset job whose reset is `aheadMs` after NOW. */
  function seedParked(id: string, aheadMs: number): string {
    const seeded = job({
      id,
      status: "waiting_for_reset",
      resetAt: new Date(NOW + aheadMs).toISOString(),
      updatedAt: new Date(NOW - DAY).toISOString(),
    });
    const existing = new RelayQueue(storePath).listAll();
    writeFileSync(storePath, JSON.stringify([...existing, seeded], null, 2), "utf8");
    return seeded.id;
  }

  it("does not touch far-future parked jobs unless --far-future is set", () => {
    const id = seedParked("far00001-2222-3333-4444-555566667777", 100 * DAY);
    const { farFuture } = recoverJobs({ storePath, now: NOW });
    expect(farFuture).toBeUndefined();
    expect(new RelayQueue(storePath).getById(id)?.resetAt).toBe(new Date(NOW + 100 * DAY).toISOString());
  });

  it("with farFuture requeues a far-future parked job due now and resets its attempts", () => {
    const id = seedParked("far00002-2222-3333-4444-555566667777", 100 * DAY);
    // Give it a spent attempt budget + stale error to prove requeueNow clears them.
    const q = new RelayQueue(storePath);
    const before = q.getById(id);
    if (before)
      writeFileSync(storePath, JSON.stringify([{ ...before, attempts: 5, lastError: "misparse" }], null, 2), "utf8");

    const { farFuture } = recoverJobs({ storePath, farFuture: true, horizonMs: HORIZON, now: NOW });
    expect(farFuture?.report.farFuture.map((j) => j.id)).toEqual([id]);
    expect(farFuture?.recovered.map((j) => j.id)).toEqual([id]);

    const after = new RelayQueue(storePath).getById(id);
    expect(after?.status).toBe("waiting_for_reset");
    expect(after?.resetAt).toBe(new Date(NOW).toISOString());
    expect(after?.attempts).toBe(0); // requeueNow resets — the distant reset was the bug
    expect(after?.lastError).toBeNull();
  });

  it("with farFuture but a disabled guard (horizonMs null) requeues nothing", () => {
    const id = seedParked("far00003-2222-3333-4444-555566667777", 100 * DAY);
    const { farFuture } = recoverJobs({ storePath, farFuture: true, horizonMs: null, now: NOW });
    expect(farFuture?.report.horizonMs).toBeNull();
    expect(farFuture?.recovered).toEqual([]);
    expect(new RelayQueue(storePath).getById(id)?.resetAt).toBe(new Date(NOW + 100 * DAY).toISOString());
  });

  it("far-future dry run reports without touching the store", () => {
    const id = seedParked("far00004-2222-3333-4444-555566667777", 100 * DAY);
    const { farFuture, dryRun } = recoverJobs({
      storePath,
      farFuture: true,
      horizonMs: HORIZON,
      dryRun: true,
      now: NOW,
    });
    expect(dryRun).toBe(true);
    expect(farFuture?.report.farFuture.map((j) => j.id)).toEqual([id]);
    expect(farFuture?.recovered).toEqual([]);
    expect(new RelayQueue(storePath).getById(id)?.resetAt).toBe(new Date(NOW + 100 * DAY).toISOString());
  });

  /** Seed a waiting_for_reset job with a null (or explicitly bad) resetAt straight to the store. */
  function seedStranded(id: string, resetAt: string | null): string {
    const seeded = job({
      id,
      status: "waiting_for_reset",
      resetAt,
      attempts: 4,
      lastError: "hand-edited",
      updatedAt: new Date(NOW - DAY).toISOString(),
      createdAt: new Date(NOW - 2 * DAY).toISOString(),
    });
    const existing = new RelayQueue(storePath).listAll();
    writeFileSync(storePath, JSON.stringify([...existing, seeded], null, 2), "utf8");
    return seeded.id;
  }

  it("does not touch stranded jobs unless --stranded is set", () => {
    const id = seedStranded("strand01-2222-3333-4444-555566667777", null);
    const { stranded } = recoverJobs({ storePath, now: NOW });
    expect(stranded).toBeUndefined();
    expect(new RelayQueue(storePath).getById(id)?.status).toBe("waiting_for_reset");
    expect(new RelayQueue(storePath).getById(id)?.resetAt).toBeNull();
  });

  it("with stranded requeues a null-resetAt job due now and resets its attempts", () => {
    const id = seedStranded("strand02-2222-3333-4444-555566667777", null);
    const { stranded } = recoverJobs({ storePath, stranded: true, now: NOW });
    expect(stranded?.report.stranded.map((j) => j.id)).toEqual([id]);
    expect(stranded?.recovered.map((j) => j.id)).toEqual([id]);

    const after = new RelayQueue(storePath).getById(id);
    expect(after?.status).toBe("waiting_for_reset");
    expect(after?.resetAt).toBe(new Date(NOW).toISOString());
    expect(after?.attempts).toBe(0); // requeueNow resets — the missing reset was the bug
    expect(after?.lastError).toBeNull();
    // Now due for the next tick, unlike before (a null resetAt is never due).
    expect(new RelayQueue(storePath).listDue(new Date(NOW + 1)).map((j) => j.id)).toContain(id);
  });

  it("with stranded also reclaims an unparseable-resetAt job", () => {
    const id = seedStranded("strand03-2222-3333-4444-555566667777", "not-a-date");
    const { stranded } = recoverJobs({ storePath, stranded: true, now: NOW });
    expect(stranded?.recovered.map((j) => j.id)).toEqual([id]);
    expect(new RelayQueue(storePath).getById(id)?.resetAt).toBe(new Date(NOW).toISOString());
  });

  it("stranded dry run reports without touching the store", () => {
    const id = seedStranded("strand04-2222-3333-4444-555566667777", null);
    const { stranded, dryRun } = recoverJobs({ storePath, stranded: true, dryRun: true, now: NOW });
    expect(dryRun).toBe(true);
    expect(stranded?.report.stranded.map((j) => j.id)).toEqual([id]);
    expect(stranded?.recovered).toEqual([]);
    expect(new RelayQueue(storePath).getById(id)?.resetAt).toBeNull();
  });

  it("leaves a parked job with a valid reset out of the stranded set", () => {
    const stranded1 = seedStranded("strand05-2222-3333-4444-555566667777", null);
    const parked = seedParked("far00099-2222-3333-4444-555566667777", 2 * 60 * 60_000); // 2h — valid
    const { stranded } = recoverJobs({ storePath, stranded: true, now: NOW });
    expect(stranded?.report.waiting).toBe(2);
    expect(stranded?.recovered.map((j) => j.id)).toEqual([stranded1]);
    // The validly-parked job is untouched.
    expect(new RelayQueue(storePath).getById(parked)?.resetAt).toBe(new Date(NOW + 2 * 60 * 60_000).toISOString());
  });
});
