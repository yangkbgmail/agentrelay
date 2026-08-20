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

  it("ignores an implausibly far-future reset on resume when a horizon is set", async () => {
    // A misparse (or an absurd wait) resolving 30 days out would otherwise park
    // the job a month. With the horizon guard, the far-future reset is dropped;
    // the resume exited 0, so the job completes instead of being re-queued.
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["claude", "-p", "continue"],
      cwd: dir,
    });
    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());

    const scheduler = new RelayScheduler({
      queue,
      maxResetHorizonMs: 8 * 24 * 60 * 60_000,
      spawnFn: fakeSpawnFn({
        "claude -p continue": "Usage limit reached. Try again in 30 days.",
      }),
    });

    const results = await scheduler.tick();
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("completed");
  });

  it("re-queues the same far-future reset when no horizon is configured", async () => {
    // Same output, but without the guard the 30-day reset is honored (the
    // historical behavior) — proving the horizon is what changed the outcome.
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
        "claude -p continue": "Usage limit reached. Try again in 30 days.",
      }),
    });

    const results = await scheduler.tick();
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("waiting_for_reset");
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

  it("caps lastOutputTail via outputTailLength (ring-buffered streaming)", async () => {
    // A chatty agent that emits many chunks before the rate-limit banner would
    // historically accumulate every byte into one string in the daemon's RSS.
    // With the ring buffer in runCommand, `lastOutputTail` must be bounded by
    // `outputTailLength` no matter how much streamed through — and the tail
    // must still contain the freshest content (i.e. the banner).
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["chatty"],
      cwd: dir,
    });
    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());

    const chunk = "x".repeat(1000);
    const banner = "\nAll done. task finished successfully.\n";
    const chattySpawn: SpawnFn = () => {
      const emitter = new EventEmitter() as any;
      emitter.stdout = new EventEmitter();
      emitter.stderr = new EventEmitter();
      setTimeout(() => {
        // 100 chunks × 1000 chars = 100_000 chars streamed, but the tail cap
        // below is 200 — the ring buffer must keep only the final ~200 chars.
        for (let i = 0; i < 100; i++) emitter.stdout.emit("data", Buffer.from(chunk));
        emitter.stdout.emit("data", Buffer.from(banner));
        emitter.emit("close", 0);
      }, 0);
      return emitter;
    };

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: chattySpawn,
      outputTailLength: 200,
    });
    const results = await scheduler.tick();
    expect(results).toHaveLength(1);
    const persisted = results[0];
    expect(persisted.status).toBe("completed");
    expect(persisted.lastOutputTail).not.toBeNull();
    expect(persisted.lastOutputTail!.length).toBeLessThanOrEqual(200);
    // Freshest content survives — the banner is the last thing emitted.
    expect(persisted.lastOutputTail!.endsWith(banner)).toBe(true);
  });

  it("still detects a rate-limit banner emitted after megabytes of prior chunks", async () => {
    // Regression: the parser only ever sees the ring-buffered tail, so this
    // proves detection still works when the banner arrives after the buffer
    // has already cycled many times.
    const job = queue.enqueue({
      project: "demo",
      tool: "claude-code",
      command: ["chatty-limited"],
      cwd: dir,
    });
    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());

    const noise = "noise-".repeat(200_000); // ~1.2 MB of leading junk
    const banner = "Usage limit reached. Resets in 2h.";
    const chattySpawn: SpawnFn = () => {
      const emitter = new EventEmitter() as any;
      emitter.stdout = new EventEmitter();
      emitter.stderr = new EventEmitter();
      setTimeout(() => {
        emitter.stdout.emit("data", Buffer.from(noise));
        emitter.stdout.emit("data", Buffer.from(banner));
        emitter.emit("close", 0);
      }, 0);
      return emitter;
    };

    const scheduler = new RelayScheduler({
      queue,
      spawnFn: chattySpawn,
      outputTailLength: 500, // ample room for the banner
    });
    const results = await scheduler.tick();
    expect(results).toHaveLength(1);
    // Parser saw the tail → job re-queued at a fresh resetAt, not marked completed.
    expect(results[0].status).toBe("waiting_for_reset");
    expect(results[0].resetAt).not.toBeNull();
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

  // A spawn fn that reports how many child processes are alive at once, so a
  // test can prove resumes actually overlap (or don't) under a concurrency cap.
  function trackingSpawnFn(track: { inFlight: number; peak: number }): SpawnFn {
    return () => {
      const emitter = new EventEmitter() as any;
      emitter.stdout = new EventEmitter();
      emitter.stderr = new EventEmitter();
      track.inFlight++;
      track.peak = Math.max(track.peak, track.inFlight);
      setTimeout(() => {
        emitter.stdout.emit("data", Buffer.from("done"));
        track.inFlight--;
        emitter.emit("close", 0);
      }, 5);
      return emitter;
    };
  }

  function seedDue(project: string): RelayJob {
    const job = queue.enqueue({ project, tool: "claude-code", command: ["claude", "-p", project], cwd: dir });
    queue.markWaitingForReset(job.id, new Date(Date.now() - 1000).toISOString());
    return job;
  }

  it("resumes a herd of due jobs one at a time by default (maxConcurrent unset)", async () => {
    const track = { inFlight: 0, peak: 0 };
    for (let i = 0; i < 5; i++) seedDue(`p${i}`);

    const scheduler = new RelayScheduler({ queue, spawnFn: trackingSpawnFn(track) });
    const results = await scheduler.tick();

    expect(results).toHaveLength(5);
    expect(track.peak).toBe(1); // strictly serial
    expect(queue.listAll().every((j) => j.status === "completed")).toBe(true);
  });

  it("resumes multiple due jobs concurrently when maxConcurrent > 1", async () => {
    const track = { inFlight: 0, peak: 0 };
    for (let i = 0; i < 5; i++) seedDue(`p${i}`);

    const scheduler = new RelayScheduler({ queue, spawnFn: trackingSpawnFn(track), maxConcurrent: 3 });
    const results = await scheduler.tick();

    expect(results).toHaveLength(5);
    expect(track.peak).toBe(3); // capped at the configured concurrency
    // Every job resumed and was persisted completed — no lost store updates
    // despite several resumes writing the JSON file in overlapping ticks.
    expect(queue.listAll().every((j) => j.status === "completed")).toBe(true);
  });

  it("keeps concurrent-tick results in due-order regardless of finish order", async () => {
    // Later jobs finish sooner, so an order-preserving map is required.
    const delays: Record<string, number> = { a: 20, b: 10, c: 0 };
    const spawnFn: SpawnFn = (command) => {
      const project = command[2];
      const emitter = new EventEmitter() as any;
      emitter.stdout = new EventEmitter();
      emitter.stderr = new EventEmitter();
      setTimeout(() => {
        emitter.stdout.emit("data", Buffer.from("done"));
        emitter.emit("close", 0);
      }, delays[project] ?? 0);
      return emitter;
    };
    // listDue returns newest-first (a enqueued first → oldest → last in due list).
    seedDue("a");
    seedDue("b");
    seedDue("c");
    const dueOrder = queue.listDue().map((j) => j.project);

    const scheduler = new RelayScheduler({ queue, spawnFn, maxConcurrent: 3 });
    const results = await scheduler.tick();

    expect(results.map((j) => j.project)).toEqual(dueOrder);
    expect(results.every((j) => j.status === "completed")).toBe(true);
  });
});
