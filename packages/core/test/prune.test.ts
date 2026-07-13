import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  autoPruneEveryMsFromEnv,
  autoPruneOptionsFromEnv,
  DEFAULT_AUTOPRUNE_AFTER_MS,
  parseDuration,
  selectPrunableJobs,
  shouldAutoPrune,
} from "../src/prune.js";
import { RelayQueue } from "../src/queue.js";
import type { RelayJob } from "../src/types.js";

function job(overrides: Partial<RelayJob>): RelayJob {
  return {
    id: overrides.id ?? "id",
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status: "completed",
    resetAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    attempts: 0,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("selectPrunableJobs", () => {
  it("prunes only terminal (completed/failed) jobs by default", () => {
    const jobs = [
      job({ id: "a", status: "completed" }),
      job({ id: "b", status: "failed" }),
      job({ id: "c", status: "queued" }),
      job({ id: "d", status: "waiting_for_reset" }),
      job({ id: "e", status: "resuming" }),
    ];
    const { prune, keep } = selectPrunableJobs(jobs);
    expect(prune.map((j) => j.id).sort()).toEqual(["a", "b"]);
    expect(keep.map((j) => j.id).sort()).toEqual(["c", "d", "e"]);
  });

  it("respects an olderThanMs age cutoff against updatedAt", () => {
    const now = new Date("2026-07-13T12:00:00.000Z");
    const jobs = [
      job({ id: "old", status: "completed", updatedAt: "2026-07-01T00:00:00.000Z" }),
      job({ id: "fresh", status: "completed", updatedAt: "2026-07-13T11:59:00.000Z" }),
    ];
    const { prune } = selectPrunableJobs(jobs, { olderThanMs: 86_400_000, now }); // 1 day
    expect(prune.map((j) => j.id)).toEqual(["old"]);
  });

  it("keeps the N most recently updated eligible jobs via keepLast", () => {
    const jobs = [
      job({ id: "j1", status: "completed", updatedAt: "2026-07-01T00:00:00.000Z" }),
      job({ id: "j2", status: "completed", updatedAt: "2026-07-02T00:00:00.000Z" }),
      job({ id: "j3", status: "completed", updatedAt: "2026-07-03T00:00:00.000Z" }),
    ];
    const { prune, keep } = selectPrunableJobs(jobs, { keepLast: 2 });
    expect(prune.map((j) => j.id)).toEqual(["j1"]);
    expect(keep.map((j) => j.id).sort()).toEqual(["j2", "j3"]);
  });

  it("can target explicit statuses (e.g. force-clear a stuck queue)", () => {
    const jobs = [job({ id: "a", status: "waiting_for_reset" }), job({ id: "b", status: "completed" })];
    const { prune } = selectPrunableJobs(jobs, { statuses: ["waiting_for_reset"] });
    expect(prune.map((j) => j.id)).toEqual(["a"]);
  });

  it("treats an unparseable updatedAt as oldest so it can be swept", () => {
    const now = new Date("2026-07-13T12:00:00.000Z");
    const jobs = [job({ id: "bad", status: "completed", updatedAt: "not-a-date" })];
    const { prune } = selectPrunableJobs(jobs, { olderThanMs: 1000, now });
    expect(prune.map((j) => j.id)).toEqual(["bad"]);
  });
});

describe("parseDuration", () => {
  it("parses supported units", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("24h")).toBe(86_400_000);
    expect(parseDuration("7d")).toBe(604_800_000);
    expect(parseDuration(" 2h ")).toBe(7_200_000);
  });

  it("returns null for invalid input", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("10")).toBeNull(); // no unit
    expect(parseDuration("10x")).toBeNull(); // unknown unit
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("-5m")).toBeNull();
  });
});

describe("RelayQueue.prune", () => {
  let dir: string;
  let queue: RelayQueue;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-prune-test-"));
    queue = new RelayQueue(join(dir, "jobs.json"));
  });

  afterEach(() => {
    queue.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("removes finished jobs and leaves active ones", () => {
    const done = queue.enqueue({ project: "a", tool: "claude-code", command: ["x"], cwd: "/tmp" });
    queue.markCompleted(done.id);
    const active = queue.enqueue({ project: "b", tool: "claude-code", command: ["y"], cwd: "/tmp" });
    queue.markWaitingForReset(active.id, new Date(Date.now() + 60_000).toISOString());

    const pruned = queue.prune();
    expect(pruned.map((j) => j.id)).toEqual([done.id]);

    const remaining = queue.listAll();
    expect(remaining.map((j) => j.id)).toEqual([active.id]);
  });

  it("dry-run reports the selection without mutating the store", () => {
    const done = queue.enqueue({ project: "a", tool: "claude-code", command: ["x"], cwd: "/tmp" });
    queue.markCompleted(done.id);

    const pruned = queue.prune({ dryRun: true });
    expect(pruned.map((j) => j.id)).toEqual([done.id]);
    // Nothing actually deleted.
    expect(queue.listAll()).toHaveLength(1);
  });

  it("persists the deletion so a fresh reader sees the smaller store", () => {
    const done = queue.enqueue({ project: "a", tool: "claude-code", command: ["x"], cwd: "/tmp" });
    queue.markFailed(done.id, "boom");
    queue.prune();

    const reopened = new RelayQueue(join(dir, "jobs.json"));
    expect(reopened.listAll()).toHaveLength(0);
    reopened.close();
  });
});

describe("autoPruneOptionsFromEnv", () => {
  it("returns null when the opt-in flag is unset or falsy", () => {
    expect(autoPruneOptionsFromEnv({})).toBeNull();
    expect(autoPruneOptionsFromEnv({ AGENTRELAY_AUTOPRUNE: "0" })).toBeNull();
    expect(autoPruneOptionsFromEnv({ AGENTRELAY_AUTOPRUNE: "false" })).toBeNull();
    // AFTER without the flag does not enable auto-prune.
    expect(autoPruneOptionsFromEnv({ AGENTRELAY_AUTOPRUNE_AFTER: "1d" })).toBeNull();
  });

  it("enables with the 7d default age when only the flag is set", () => {
    expect(autoPruneOptionsFromEnv({ AGENTRELAY_AUTOPRUNE: "1" })).toEqual({
      olderThanMs: DEFAULT_AUTOPRUNE_AFTER_MS,
      keepLast: undefined,
    });
    // Accepts the other truthy spellings.
    for (const v of ["true", "yes", "on", "ON"]) {
      expect(autoPruneOptionsFromEnv({ AGENTRELAY_AUTOPRUNE: v })?.olderThanMs).toBe(DEFAULT_AUTOPRUNE_AFTER_MS);
    }
  });

  it("honors a custom AFTER duration and KEEP count", () => {
    expect(
      autoPruneOptionsFromEnv({
        AGENTRELAY_AUTOPRUNE: "on",
        AGENTRELAY_AUTOPRUNE_AFTER: "24h",
        AGENTRELAY_AUTOPRUNE_KEEP: "5",
      })
    ).toEqual({ olderThanMs: parseDuration("24h"), keepLast: 5 });
  });

  it("treats AFTER=0s as prune-all-finished (no age filter)", () => {
    expect(autoPruneOptionsFromEnv({ AGENTRELAY_AUTOPRUNE: "1", AGENTRELAY_AUTOPRUNE_AFTER: "0s" })).toEqual({
      olderThanMs: 0,
      keepLast: undefined,
    });
  });

  it("falls back to the default age when AFTER is unparseable (still opted in)", () => {
    expect(
      autoPruneOptionsFromEnv({ AGENTRELAY_AUTOPRUNE: "1", AGENTRELAY_AUTOPRUNE_AFTER: "garbage" })?.olderThanMs
    ).toBe(DEFAULT_AUTOPRUNE_AFTER_MS);
  });

  it("ignores a negative/invalid KEEP", () => {
    expect(
      autoPruneOptionsFromEnv({ AGENTRELAY_AUTOPRUNE: "1", AGENTRELAY_AUTOPRUNE_KEEP: "-3" })?.keepLast
    ).toBeUndefined();
  });
});

describe("autoPruneEveryMsFromEnv", () => {
  it("returns null when unset (no throttle)", () => {
    expect(autoPruneEveryMsFromEnv({})).toBeNull();
    expect(autoPruneEveryMsFromEnv({ AGENTRELAY_AUTOPRUNE_EVERY: "" })).toBeNull();
    expect(autoPruneEveryMsFromEnv({ AGENTRELAY_AUTOPRUNE_EVERY: "   " })).toBeNull();
  });

  it("parses a valid duration to milliseconds", () => {
    expect(autoPruneEveryMsFromEnv({ AGENTRELAY_AUTOPRUNE_EVERY: "1h" })).toBe(3_600_000);
    expect(autoPruneEveryMsFromEnv({ AGENTRELAY_AUTOPRUNE_EVERY: "30m" })).toBe(1_800_000);
    expect(autoPruneEveryMsFromEnv({ AGENTRELAY_AUTOPRUNE_EVERY: "10s" })).toBe(10_000);
  });

  it("returns null (no throttle) for unparseable or non-positive values", () => {
    // A typo must not silently disable pruning — it just falls back to every tick.
    expect(autoPruneEveryMsFromEnv({ AGENTRELAY_AUTOPRUNE_EVERY: "garbage" })).toBeNull();
    expect(autoPruneEveryMsFromEnv({ AGENTRELAY_AUTOPRUNE_EVERY: "0s" })).toBeNull();
  });
});

describe("shouldAutoPrune", () => {
  it("always runs when no throttle is configured", () => {
    expect(shouldAutoPrune(null, 1000)).toBe(true);
    expect(shouldAutoPrune(500, 1000, 0)).toBe(true);
  });

  it("always runs on the first pass even with a throttle", () => {
    expect(shouldAutoPrune(null, 1000, 60_000)).toBe(true);
  });

  it("skips until the interval has elapsed, then runs again", () => {
    const every = 60_000;
    expect(shouldAutoPrune(1_000_000, 1_030_000, every)).toBe(false); // 30s < 60s
    expect(shouldAutoPrune(1_000_000, 1_059_999, every)).toBe(false); // just under
    expect(shouldAutoPrune(1_000_000, 1_060_000, every)).toBe(true); // exactly at boundary
    expect(shouldAutoPrune(1_000_000, 1_120_000, every)).toBe(true); // well past
  });
});
