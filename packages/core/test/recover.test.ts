import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_RESET_HORIZON_MS } from "../src/parser.js";
import { RelayQueue } from "../src/queue.js";
import { DEFAULT_STUCK_RESUMING_MS, selectFarFutureParkedJobs, selectStuckResumingJobs } from "../src/recover.js";
import type { RelayJob } from "../src/types.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");

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

/** ISO string for `ms` before NOW. */
function agoIso(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe("selectStuckResumingJobs", () => {
  it("selects resuming jobs older than the threshold and ignores fresh ones", () => {
    const jobs = [
      job({ id: "old", updatedAt: agoIso(45 * 60_000) }), // 45m — stuck
      job({ id: "fresh", updatedAt: agoIso(2 * 60_000) }), // 2m — a live run
    ];
    const report = selectStuckResumingJobs(jobs, { nowMs: NOW });
    expect(report.stuckAfterMs).toBe(DEFAULT_STUCK_RESUMING_MS);
    expect(report.resuming).toBe(2);
    expect(report.stuck.map((j) => j.id)).toEqual(["old"]);
  });

  it("ignores non-resuming jobs entirely", () => {
    const jobs = [
      job({ id: "done", status: "completed", updatedAt: agoIso(10 * 60 * 60_000) }),
      job({ id: "waiting", status: "waiting_for_reset", updatedAt: agoIso(10 * 60 * 60_000) }),
      job({ id: "stuck", updatedAt: agoIso(60 * 60_000) }),
    ];
    const report = selectStuckResumingJobs(jobs, { nowMs: NOW });
    expect(report.total).toBe(3);
    expect(report.resuming).toBe(1);
    expect(report.stuck.map((j) => j.id)).toEqual(["stuck"]);
  });

  it("orders stuck jobs oldest-first", () => {
    const jobs = [
      job({ id: "b", updatedAt: agoIso(60 * 60_000) }),
      job({ id: "a", updatedAt: agoIso(3 * 60 * 60_000) }),
      job({ id: "c", updatedAt: agoIso(40 * 60_000) }),
    ];
    const report = selectStuckResumingJobs(jobs, { nowMs: NOW });
    expect(report.stuck.map((j) => j.id)).toEqual(["a", "b", "c"]);
  });

  it("treats an unparseable updatedAt as stuck (no live loop would write one)", () => {
    const jobs = [job({ id: "corrupt", updatedAt: "not-a-date" })];
    const report = selectStuckResumingJobs(jobs, { nowMs: NOW });
    expect(report.stuck.map((j) => j.id)).toEqual(["corrupt"]);
  });

  it("with stuckAfterMs 0 selects every resuming job regardless of age", () => {
    const jobs = [
      job({ id: "just-now", updatedAt: agoIso(1_000) }),
      job({ id: "older", updatedAt: agoIso(5 * 60_000) }),
    ];
    const report = selectStuckResumingJobs(jobs, { nowMs: NOW, stuckAfterMs: 0 });
    expect(report.stuckAfterMs).toBe(0);
    expect(report.stuck.map((j) => j.id).sort()).toEqual(["just-now", "older"]);
  });

  it("returns an empty selection when nothing is stuck", () => {
    const report = selectStuckResumingJobs([job({ id: "fresh", updatedAt: agoIso(1_000) })], { nowMs: NOW });
    expect(report.stuck).toEqual([]);
    expect(report.resuming).toBe(1);
  });
});

/** ISO string for `ms` after NOW. */
function inIso(ms: number): string {
  return new Date(NOW + ms).toISOString();
}

const DAY = 24 * 60 * 60_000;

describe("selectFarFutureParkedJobs", () => {
  it("selects parked jobs whose reset is beyond the horizon, ignoring near ones", () => {
    const jobs = [
      job({ id: "far", status: "waiting_for_reset", resetAt: inIso(30 * DAY) }), // 30d out — misparsed
      job({ id: "near", status: "waiting_for_reset", resetAt: inIso(2 * 60 * 60_000) }), // 2h — believable
    ];
    const report = selectFarFutureParkedJobs(jobs, { nowMs: NOW, horizonMs: DEFAULT_MAX_RESET_HORIZON_MS });
    expect(report.waiting).toBe(2);
    expect(report.horizonMs).toBe(DEFAULT_MAX_RESET_HORIZON_MS);
    expect(report.parked.map((j) => j.id)).toEqual(["far"]);
  });

  it("only considers waiting_for_reset jobs (resuming/queued/terminal are skipped)", () => {
    const jobs = [
      job({ id: "resuming", status: "resuming", resetAt: inIso(100 * DAY) }),
      job({ id: "queued", status: "queued", resetAt: inIso(100 * DAY) }),
      job({ id: "done", status: "completed", resetAt: inIso(100 * DAY) }),
      job({ id: "parked", status: "waiting_for_reset", resetAt: inIso(100 * DAY) }),
    ];
    const report = selectFarFutureParkedJobs(jobs, { nowMs: NOW, horizonMs: DEFAULT_MAX_RESET_HORIZON_MS });
    expect(report.waiting).toBe(1);
    expect(report.parked.map((j) => j.id)).toEqual(["parked"]);
  });

  it("orders parked jobs soonest-reset first, tie-broken by id", () => {
    const jobs = [
      job({ id: "c", status: "waiting_for_reset", resetAt: inIso(90 * DAY) }),
      job({ id: "a", status: "waiting_for_reset", resetAt: inIso(30 * DAY) }),
      job({ id: "b", status: "waiting_for_reset", resetAt: inIso(30 * DAY) }),
    ];
    const report = selectFarFutureParkedJobs(jobs, { nowMs: NOW, horizonMs: DEFAULT_MAX_RESET_HORIZON_MS });
    expect(report.parked.map((j) => j.id)).toEqual(["a", "b", "c"]);
  });

  it("skips a past reset (already unblocked — safe to resume) and unparseable resetAt", () => {
    const jobs = [
      job({ id: "past", status: "waiting_for_reset", resetAt: agoIso(DAY) }),
      job({ id: "bad", status: "waiting_for_reset", resetAt: "not-a-date" }),
      job({ id: "missing", status: "waiting_for_reset", resetAt: null }),
    ];
    const report = selectFarFutureParkedJobs(jobs, { nowMs: NOW, horizonMs: DEFAULT_MAX_RESET_HORIZON_MS });
    expect(report.waiting).toBe(3);
    expect(report.parked).toEqual([]);
  });

  it("with the guard disabled (null/0 horizon) flags nothing and reports horizonMs null", () => {
    const jobs = [job({ id: "far", status: "waiting_for_reset", resetAt: inIso(365 * DAY) })];
    for (const horizonMs of [null, 0, -1, Number.POSITIVE_INFINITY]) {
      const report = selectFarFutureParkedJobs(jobs, { nowMs: NOW, horizonMs });
      expect(report.parked).toEqual([]);
      expect(report.horizonMs).toBeNull();
    }
  });

  it("does not mutate the input", () => {
    const jobs = [job({ id: "far", status: "waiting_for_reset", resetAt: inIso(100 * DAY) })];
    const before = JSON.stringify(jobs);
    selectFarFutureParkedJobs(jobs, { nowMs: NOW, horizonMs: DEFAULT_MAX_RESET_HORIZON_MS });
    expect(JSON.stringify(jobs)).toBe(before);
  });
});

describe("RelayQueue.recoverResuming", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-recover-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("requeues a stuck resuming job to run now while preserving attempts", () => {
    const queue = new RelayQueue(join(dir, "jobs.json"));
    const created = queue.enqueue({ project: "demo", tool: "claude-code", command: ["claude"], cwd: "/tmp" });
    queue.markResuming(created.id); // attempts → 1, status → resuming
    expect(queue.getById(created.id)?.attempts).toBe(1);

    const at = "2026-08-15T12:00:00.000Z";
    expect(queue.recoverResuming(created.id, at)).toBe(true);

    const recovered = queue.getById(created.id);
    expect(recovered?.status).toBe("waiting_for_reset");
    expect(recovered?.resetAt).toBe(at);
    expect(recovered?.attempts).toBe(1); // preserved — the crashed attempt still counts
    expect(recovered?.lastError).toContain("interrupted resume");
    // Immediately due for the next tick.
    expect(queue.listDue(new Date(Date.parse(at) + 1)).map((j) => j.id)).toContain(created.id);
    queue.close();
  });

  it("is a no-op returning false when the job is not resuming", () => {
    const queue = new RelayQueue(join(dir, "jobs.json"));
    const created = queue.enqueue({ project: "demo", tool: "claude-code", command: ["claude"], cwd: "/tmp" });
    // Still `queued`, not `resuming`.
    expect(queue.recoverResuming(created.id)).toBe(false);
    expect(queue.getById(created.id)?.status).toBe("queued");
    expect(queue.recoverResuming("no-such-id")).toBe(false);
    queue.close();
  });
});
