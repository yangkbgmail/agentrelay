import type { DrainProgress } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { formatDrainProgress, renderDrainJson } from "../src/drain.js";

function draining(overrides: Partial<DrainProgress> = {}): DrainProgress {
  return { done: false, active: 3, queued: 1, waiting: 1, resuming: 1, ...overrides };
}

describe("formatDrainProgress", () => {
  it("lists the non-zero buckets with the total", () => {
    expect(formatDrainProgress(draining())).toBe("3 active jobs: 1 queued, 1 waiting, 1 resuming");
  });

  it("omits zero buckets and uses the singular for a single job", () => {
    expect(formatDrainProgress(draining({ active: 1, queued: 0, waiting: 1, resuming: 0 }))).toBe(
      "1 active job: 1 waiting"
    );
  });

  it("falls back to the bare count when no bucket is populated", () => {
    expect(formatDrainProgress({ done: false, active: 0, queued: 0, waiting: 0, resuming: 0 })).toBe("0 active jobs");
  });
});

describe("renderDrainJson", () => {
  it("produces the wait/eta envelope with outcome, exitCode, and progress", () => {
    const parsed = JSON.parse(
      renderDrainJson(
        {
          outcome: "drained",
          progress: { done: true, active: 0, queued: 0, waiting: 0, resuming: 0, outcome: "drained" },
          exitCode: 0,
        },
        "/tmp/store.json",
        "2026-08-16T10:00:00.000Z"
      )
    );
    expect(parsed.storePath).toBe("/tmp/store.json");
    expect(parsed.generatedAt).toBe("2026-08-16T10:00:00.000Z");
    expect(parsed.outcome).toBe("drained");
    expect(parsed.exitCode).toBe(0);
    expect(parsed.progress.active).toBe(0);
  });

  it("carries the timeout outcome and the remaining active breakdown", () => {
    const parsed = JSON.parse(
      renderDrainJson(
        { outcome: "timeout", progress: draining({ active: 2, resuming: 0 }), exitCode: 124 },
        "/tmp/store.json"
      )
    );
    expect(parsed.outcome).toBe("timeout");
    expect(parsed.exitCode).toBe(124);
    expect(parsed.progress.active).toBe(2);
    expect(parsed.progress.queued).toBe(1);
  });
});
