import { describe, expect, it } from "vitest";
import {
  compareByPriority,
  DEFAULT_PRIORITY,
  jobPriority,
  normalizePriority,
  sortByPriority,
} from "../src/priority.js";
import type { RelayJob } from "../src/types.js";

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "id",
    project: "proj",
    tool: "generic",
    command: ["echo", "hi"],
    cwd: "/tmp",
    status: "waiting_for_reset",
    resetAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    attempts: 0,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("jobPriority", () => {
  it("returns the priority when it is a finite number", () => {
    expect(jobPriority(job({ priority: 7 }))).toBe(7);
    expect(jobPriority(job({ priority: -3 }))).toBe(-3);
    expect(jobPriority(job({ priority: 0 }))).toBe(0);
  });

  it("falls back to the default for legacy stores (field absent)", () => {
    expect(jobPriority(job())).toBe(DEFAULT_PRIORITY);
    expect(jobPriority(job({ priority: undefined }))).toBe(0);
  });

  it("falls back to the default for corrupt values (NaN/Infinity/non-number)", () => {
    expect(jobPriority(job({ priority: Number.NaN }))).toBe(0);
    expect(jobPriority(job({ priority: Number.POSITIVE_INFINITY }))).toBe(0);
    // biome-ignore lint/suspicious/noExplicitAny: exercising a corrupt store value
    expect(jobPriority(job({ priority: "5" as any }))).toBe(0);
  });
});

describe("normalizePriority", () => {
  it("passes finite integers through unchanged", () => {
    expect(normalizePriority(10)).toBe(10);
    expect(normalizePriority(-5)).toBe(-5);
    expect(normalizePriority(0)).toBe(0);
  });

  it("truncates fractional values toward zero", () => {
    expect(normalizePriority(2.9)).toBe(2);
    expect(normalizePriority(-2.9)).toBe(-2);
  });

  it("maps nullish / non-finite inputs to the default", () => {
    expect(normalizePriority(undefined)).toBe(DEFAULT_PRIORITY);
    expect(normalizePriority(null)).toBe(0);
    expect(normalizePriority(Number.NaN)).toBe(0);
    expect(normalizePriority(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("compareByPriority", () => {
  it("orders higher priority first", () => {
    expect(compareByPriority(job({ priority: 10 }), job({ priority: 1 }))).toBeLessThan(0);
    expect(compareByPriority(job({ priority: 1 }), job({ priority: 10 }))).toBeGreaterThan(0);
  });

  it("treats a missing priority as the default 0", () => {
    // default (0) beats a negative one, loses to a positive one
    expect(compareByPriority(job(), job({ priority: -1 }))).toBeLessThan(0);
    expect(compareByPriority(job(), job({ priority: 1 }))).toBeGreaterThan(0);
  });

  it("breaks equal-priority ties by earliest resetAt", () => {
    const early = job({ id: "a", resetAt: "2026-01-01T00:00:00.000Z" });
    const late = job({ id: "b", resetAt: "2026-01-01T01:00:00.000Z" });
    expect(compareByPriority(early, late)).toBeLessThan(0);
  });

  it("breaks resetAt ties by earliest createdAt, then id", () => {
    const older = job({ id: "b", createdAt: "2026-01-01T00:00:00.000Z" });
    const newer = job({ id: "a", createdAt: "2026-01-01T02:00:00.000Z" });
    expect(compareByPriority(older, newer)).toBeLessThan(0);
    // same everything but id -> lexicographic id tiebreak
    const x = job({ id: "aaa" });
    const y = job({ id: "bbb" });
    expect(compareByPriority(x, y)).toBeLessThan(0);
  });

  it("sorts null/unparseable resetAt last within a priority group", () => {
    const withReset = job({ id: "a", resetAt: "2026-01-01T00:00:00.000Z" });
    const noReset = job({ id: "b", resetAt: null });
    expect(compareByPriority(withReset, noReset)).toBeLessThan(0);
  });
});

describe("sortByPriority", () => {
  it("returns a new array without mutating the input", () => {
    const input = [job({ id: "a", priority: 1 }), job({ id: "b", priority: 5 })];
    const sorted = sortByPriority(input);
    expect(sorted).not.toBe(input);
    expect(sorted.map((j) => j.id)).toEqual(["b", "a"]);
    expect(input.map((j) => j.id)).toEqual(["a", "b"]); // original untouched
  });

  it("produces a fully deterministic order for a mixed batch", () => {
    const jobs = [
      job({ id: "low", priority: -1, resetAt: "2026-01-01T00:00:00.000Z" }),
      job({ id: "hi", priority: 10, resetAt: "2026-01-01T05:00:00.000Z" }),
      job({ id: "mid-late", priority: 0, resetAt: "2026-01-01T02:00:00.000Z" }),
      job({ id: "mid-early", priority: 0, resetAt: "2026-01-01T01:00:00.000Z" }),
    ];
    expect(sortByPriority(jobs).map((j) => j.id)).toEqual(["hi", "mid-early", "mid-late", "low"]);
  });
});
