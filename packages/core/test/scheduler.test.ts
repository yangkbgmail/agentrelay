import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RelayQueue } from "../src/queue.js";
import type { SpawnFn } from "../src/scheduler.js";
import { RelayScheduler } from "../src/scheduler.js";
import type { RelayJob } from "../src/types.js";

// Minimal fake ChildProcess: emits given stdout data then closes.
function fakeSpawnFn(outputs: Record<string, string>): SpawnFn {
  return (command) => {
    const key = command.join(" ");
    const emitter = new EventEmitter() as any;
    emitter.stdout = new EventEmitter();
    emitter.stderr = new EventEmitter();
    setTimeout(() => {
      emitter.stdout.emit("data", Buffer.from(outputs[key] ?? ""));
      emitter.emit("close", 0);
    }, 0);
    return emitter;
  };
}

// Fake ChildProcess that closes with a given exit code (default 0) and,
// optionally, emits an `error` event instead of closing cleanly.
function fakeSpawnWith(opts: { output?: string; exitCode?: number; error?: Error }): SpawnFn {
  return () => {
    const emitter = new EventEmitter() as any;
    emitter.stdout = new EventEmitter();
    emitter.stderr = new EventEmitter();
    setTimeout(() => {
      if (opts.output) emitter.stdout.emit("data", Buffer.from(opts.output));
      if (opts.error) {
        emitter.emit("error", opts.error);
      } else {
        emitter.emit("close", opts.exitCode ?? 0);
      }
    }, 0);
    return emitter;
  };
}

describe("RelayScheduler", () => {
  let dir: string;
  let queue: RelayQueue;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-sched-test-"));
    queue = new RelayQueue(join(dir, "test.db"));
  });

  afterEach(() => {
    queue.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("marks a job completed when the resumed command succeeds without hitting a limit again", async () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnFn({ "claude -p continue": "All done, task finished successfully." }),
    });

    const results = await scheduler.tick();
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("completed");
  });

  it("re-queues a job that hits the rate limit again during resume", async () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnFn({
        "claude -p continue": "Usage limit reached again. Resets in 2h.",
      }),
    });

    const results = await scheduler.tick();
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("waiting_for_reset");
    expect(results[0].resetAt).not.toBeNull();
  });

  it("does not touch jobs that are not yet due", async () => {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    queue.markWaitingForReset(job.id, new Date(Date.now() + 60_000).toISOString());

    const scheduler = new RelayScheduler({ queue, spawnFn: fakeSpawnFn({}) });
    const results = await scheduler.tick();
    expect(results).toHaveLength(0);
  });

  function dueJob() {
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());
    return job;
  }

  it("backs off and re-queues a job whose command exits non-zero (transient failure)", async () => {
    dueJob(); // resetAt = Date.now() - 1000
    const now = new Date(Date.now() + 1000); // reference time after the job became due
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnWith({ output: "boom", exitCode: 1 }),
      retryPolicy: { maxAttempts: 5, baseDelayMs: 60_000, factor: 2, maxDelayMs: 3_600_000, jitter: 0 },
    });

    const [result] = await scheduler.tick(now);
    expect(result.status).toBe("waiting_for_reset");
    // attempt 1 -> base delay of 60s from the reference time
    expect(result.resetAt).toBe(new Date(now.getTime() + 60_000).toISOString());
    expect(result.lastError).toContain("exited with code 1");
  });

  it("spreads the backoff delay when jitter is set, using the injected rng", async () => {
    dueJob(); // resetAt = Date.now() - 1000
    const now = new Date(Date.now() + 1000);
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnWith({ output: "boom", exitCode: 1 }),
      // attempt 1 base delay = 60s; ±50% jitter → window [30s, 90s].
      retryPolicy: { maxAttempts: 5, baseDelayMs: 60_000, factor: 2, maxDelayMs: 3_600_000, jitter: 0.5 },
      rng: () => 1, // deterministic high end of the window
    });

    const [result] = await scheduler.tick(now);
    expect(result.status).toBe("waiting_for_reset");
    expect(result.resetAt).toBe(new Date(now.getTime() + 90_000).toISOString());
  });

  it("retries a spawn/child error rather than dropping the job", async () => {
    dueJob();
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnWith({ error: new Error("ENOENT") }),
    });

    const [result] = await scheduler.tick();
    expect(result.status).toBe("waiting_for_reset");
    expect(result.lastError).toContain("ENOENT");
  });

  it("marks a job failed once it exhausts maxAttempts on repeated failures", async () => {
    const job = dueJob();
    // Simulate a job that has already burned through its budget.
    queue.markResuming(job.id); // attempts -> 1
    queue.markResuming(job.id); // attempts -> 2
    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnWith({ output: "still broken", exitCode: 2 }),
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1000, factor: 2, maxDelayMs: 10_000, jitter: 0 },
    });

    // This resume is attempt 3 (== maxAttempts) -> should fail, not retry.
    const [result] = await scheduler.tick();
    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(3);
    expect(result.lastError).toContain("Failed after 3 attempt(s)");
  });

  it("gives up on a job that stays rate-limited past maxAttempts", async () => {
    const job = dueJob();
    queue.markResuming(job.id); // attempts -> 1
    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnWith({ output: "Usage limit reached. Resets in 2h." }),
      retryPolicy: { maxAttempts: 2, baseDelayMs: 1000, factor: 2, maxDelayMs: 10_000, jitter: 0 },
    });

    // attempt 2 == maxAttempts, still rate-limited -> failed instead of looping.
    const [result] = await scheduler.tick();
    expect(result.status).toBe("failed");
    expect(result.lastError).toContain("Still rate-limited");
  });

  it("keeps re-queuing a rate-limited job forever when maxAttempts is 0", async () => {
    const job = dueJob();
    queue.markResuming(job.id);
    queue.markResuming(job.id);
    queue.markResuming(job.id); // attempts -> 3, well past a normal cap
    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnWith({ output: "Usage limit reached. Resets in 2h." }),
      retryPolicy: { maxAttempts: 0, baseDelayMs: 1000, factor: 2, maxDelayMs: 10_000, jitter: 0 },
    });

    const [result] = await scheduler.tick();
    expect(result.status).toBe("waiting_for_reset");
  });

  it("auto-prunes finished jobs after a tick (age 0), leaving active jobs untouched", async () => {
    const done = queue.enqueue({ project: "done", tool: "claude-code", command: ["x"], cwd: dir });
    queue.markCompleted(done.id, "done");
    const active = queue.enqueue({ project: "active", tool: "claude-code", command: ["y"], cwd: dir });
    queue.markWaitingForReset(active.id, new Date(Date.now() + 60_000).toISOString());

    const pruned: RelayJob[][] = [];
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnFn({}),
      autoPrune: { olderThanMs: 0 }, // no age filter → sweep every finished job
      onPrune: (jobs) => pruned.push(jobs),
    });

    await scheduler.tick();

    expect(pruned).toHaveLength(1);
    expect(pruned[0].map((j) => j.id)).toEqual([done.id]);
    // The finished job is gone; the active one survives.
    expect(queue.listAll().map((j) => j.id)).toEqual([active.id]);
  });

  it("respects the auto-prune age threshold — a just-finished job survives", async () => {
    const done = queue.enqueue({ project: "recent", tool: "claude-code", command: ["x"], cwd: dir });
    queue.markCompleted(done.id, "done"); // updatedAt = now

    const pruned: RelayJob[][] = [];
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnFn({}),
      autoPrune: { olderThanMs: 60 * 60_000 }, // only jobs untouched for 1h+
      onPrune: (jobs) => pruned.push(jobs),
    });

    await scheduler.tick();

    expect(pruned).toHaveLength(0);
    expect(queue.listAll().map((j) => j.id)).toEqual([done.id]);
  });

  it("does not prune when auto-prune is not configured", async () => {
    const done = queue.enqueue({ project: "done", tool: "claude-code", command: ["x"], cwd: dir });
    queue.markCompleted(done.id, "done");

    const scheduler = new RelayScheduler({ queue, spawnFn: fakeSpawnFn({}) });
    await scheduler.tick();

    expect(queue.listAll().map((j) => j.id)).toEqual([done.id]);
  });

  it("throttles auto-prune to at most once per autoPruneEveryMs window", async () => {
    const pruned: RelayJob[][] = [];
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnFn({}),
      autoPrune: { olderThanMs: 0 }, // sweep every finished job
      autoPruneEveryMs: 60_000, // ...but at most once a minute
      onPrune: (jobs) => pruned.push(jobs),
    });

    const t0 = new Date("2026-07-13T00:00:00Z");
    // First tick always prunes: seed a finished job then tick at t0.
    const first = queue.enqueue({ project: "a", tool: "claude-code", command: ["x"], cwd: dir });
    queue.markCompleted(first.id, "done");
    await scheduler.tick(t0);
    expect(pruned).toHaveLength(1);
    expect(pruned[0].map((j) => j.id)).toEqual([first.id]);

    // A second finished job appears, but the next tick is inside the window → skipped.
    const second = queue.enqueue({ project: "b", tool: "claude-code", command: ["y"], cwd: dir });
    queue.markCompleted(second.id, "done");
    await scheduler.tick(new Date(t0.getTime() + 30_000)); // +30s < 60s
    expect(pruned).toHaveLength(1); // no new pass
    expect(queue.listAll().map((j) => j.id)).toEqual([second.id]); // still present

    // Once the window elapses, the pending finished job is swept.
    await scheduler.tick(new Date(t0.getTime() + 60_000)); // +60s ≥ 60s
    expect(pruned).toHaveLength(2);
    expect(pruned[1].map((j) => j.id)).toEqual([second.id]);
    expect(queue.listAll()).toHaveLength(0);
  });

  it("throttles auto-prune to every N ticks regardless of wall-clock time", async () => {
    const pruned: RelayJob[][] = [];
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnFn({}),
      autoPrune: { olderThanMs: 0 }, // sweep every finished job
      autoPruneEveryTicks: 3, // ...but only every 3rd tick
      onPrune: (jobs) => pruned.push(jobs),
    });

    const seedFinished = (project: string) => {
      const job = queue.enqueue({ project, tool: "claude-code", command: ["x"], cwd: dir });
      queue.markCompleted(job.id, "done");
      return job;
    };

    // Tick 0 (index 0) always prunes.
    const a = seedFinished("a");
    await scheduler.tick();
    expect(pruned).toHaveLength(1);
    expect(pruned[0].map((j) => j.id)).toEqual([a.id]);

    // Ticks 1 and 2 are inside the tick window → skipped even though new jobs finish.
    const b = seedFinished("b");
    await scheduler.tick();
    await scheduler.tick();
    expect(pruned).toHaveLength(1); // no new pass
    expect(queue.listAll().map((j) => j.id)).toEqual([b.id]); // still present

    // Tick 3 (index 3) is a multiple of 3 → prunes again.
    await scheduler.tick();
    expect(pruned).toHaveLength(2);
    expect(pruned[1].map((j) => j.id)).toEqual([b.id]);
    expect(queue.listAll()).toHaveLength(0);
  });

  it("requires both time and tick throttles to permit a pass when both are set", async () => {
    const pruned: RelayJob[][] = [];
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnFn({}),
      autoPrune: { olderThanMs: 0 },
      autoPruneEveryMs: 60_000, // at most once a minute...
      autoPruneEveryTicks: 2, // ...AND only on even tick indices
      onPrune: (jobs) => pruned.push(jobs),
    });

    const t0 = new Date("2026-07-13T00:00:00Z");
    const at = (ms: number) => new Date(t0.getTime() + ms);
    const seedFinished = (project: string) => {
      const job = queue.enqueue({ project, tool: "claude-code", command: ["x"], cwd: dir });
      queue.markCompleted(job.id, "done");
      return job;
    };

    // Tick index 0, first pass: both gates allow → prune.
    const a = seedFinished("a");
    await scheduler.tick(t0);
    expect(pruned).toHaveLength(1);
    expect(pruned[0].map((j) => j.id)).toEqual([a.id]);

    // Tick index 1 @ +90s: time gate would allow (90s ≥ 60s), but tick gate blocks → skip.
    const b = seedFinished("b");
    await scheduler.tick(at(90_000));
    expect(pruned).toHaveLength(1);
    expect(queue.listAll().map((j) => j.id)).toEqual([b.id]);

    // Tick index 2 @ +100s: both gates allow (100s since last pass, even index) → prune.
    await scheduler.tick(at(100_000));
    expect(pruned).toHaveLength(2);
    expect(pruned[1].map((j) => j.id)).toEqual([b.id]);

    // Tick index 3 @ +120s: tick gate blocks → skip.
    const c = seedFinished("c");
    await scheduler.tick(at(120_000));
    expect(pruned).toHaveLength(2);

    // Tick index 4 @ +130s: tick gate allows, but only 30s since last pass → time gate blocks → skip.
    await scheduler.tick(at(130_000));
    expect(pruned).toHaveLength(2);
    expect(queue.listAll().map((j) => j.id)).toEqual([c.id]);

    // Tick index 6 @ +200s: even index and 100s since last pass → both allow → prune.
    await scheduler.tick(at(170_000)); // index 5: tick gate blocks
    await scheduler.tick(at(200_000)); // index 6: prune
    expect(pruned).toHaveLength(3);
    expect(pruned[2].map((j) => j.id)).toEqual([c.id]);
    expect(queue.listAll()).toHaveLength(0);
  });

  it("fires onTick after every tick with the reference time, even when nothing is due", async () => {
    const seen: number[] = [];
    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnFn({}),
      onTick: (referenceTime) => {
        seen.push(referenceTime.getTime());
      },
    });

    await scheduler.tick(new Date(1000));
    await scheduler.tick(new Date(2000));

    expect(seen).toEqual([1000, 2000]);
  });

  it("swallows an onTick error so the relay loop keeps running", async () => {
    const job = queue.enqueue({ project: "p", tool: "claude-code", command: ["cmd"], cwd: dir });
    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString()); // due now

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: fakeSpawnFn({ cmd: "ok" }),
      onTick: () => {
        throw new Error("heartbeat write failed");
      },
    });

    const processed = await scheduler.tick();
    // The due job was still resumed despite the throwing hook.
    expect(processed).toHaveLength(1);
    expect(queue.getById(job.id)?.status).toBe("completed");
  });
});
