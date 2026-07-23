import { describe, expect, it } from "vitest";
import { jobsToJson, jobsToNdjson } from "../src/export.js";
import {
  ACTIVE_IMPORT_STATUSES,
  IMPORT_FORMATS,
  inferImportFormat,
  isImportFormat,
  parseImportJobs,
  planImport,
  summarizeImportPlan,
  validateJobRecord,
} from "../src/import.js";
import type { RelayJob } from "../src/types.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "proj",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "completed",
    resetAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T01:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("isImportFormat", () => {
  it("accepts the lossless formats and rejects the rest", () => {
    expect(isImportFormat("json")).toBe(true);
    expect(isImportFormat("ndjson")).toBe(true);
    expect(isImportFormat("csv")).toBe(false);
    expect(isImportFormat("md")).toBe(false);
    expect(isImportFormat("")).toBe(false);
  });

  it("only exposes json/ndjson", () => {
    expect([...IMPORT_FORMATS]).toEqual(["json", "ndjson"]);
  });
});

describe("inferImportFormat", () => {
  it("maps extensions (case-insensitive)", () => {
    expect(inferImportFormat("jobs.json")).toBe("json");
    expect(inferImportFormat("/a/b/JOBS.JSON")).toBe("json");
    expect(inferImportFormat("dump.ndjson")).toBe("ndjson");
    expect(inferImportFormat("dump.jsonl")).toBe("ndjson");
  });

  it("returns null for unknown/absent extensions", () => {
    expect(inferImportFormat("jobs.csv")).toBeNull();
    expect(inferImportFormat("jobs.md")).toBeNull();
    expect(inferImportFormat("jobs")).toBeNull();
  });
});

describe("validateJobRecord", () => {
  it("accepts a well-formed job and clones the command array", () => {
    const j = job();
    const result = validateJobRecord(j);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.job).toEqual(j);
      expect(result.job.command).not.toBe(j.command);
    }
  });

  it("ignores unknown extra keys (forward compatible)", () => {
    const result = validateJobRecord({ ...job(), futureField: 42 });
    expect(result.ok).toBe(true);
    if (result.ok) expect("futureField" in result.job).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(validateJobRecord(null).ok).toBe(false);
    expect(validateJobRecord("x").ok).toBe(false);
    expect(validateJobRecord([job()]).ok).toBe(false);
  });

  it("rejects a missing/blank id", () => {
    expect(validateJobRecord({ ...job(), id: "" }).ok).toBe(false);
    const { id: _omit, ...noId } = job();
    expect(validateJobRecord(noId).ok).toBe(false);
  });

  it("rejects unknown tool and status", () => {
    expect(validateJobRecord({ ...job(), tool: "cursor" }).ok).toBe(false);
    expect(validateJobRecord({ ...job(), status: "paused" }).ok).toBe(false);
  });

  it("rejects a non-array or empty command", () => {
    expect(validateJobRecord({ ...job(), command: "claude -p go" }).ok).toBe(false);
    expect(validateJobRecord({ ...job(), command: [] }).ok).toBe(false);
    expect(validateJobRecord({ ...job(), command: ["ok", 3] }).ok).toBe(false);
  });

  it("rejects a bad attempts value", () => {
    expect(validateJobRecord({ ...job(), attempts: -1 }).ok).toBe(false);
    expect(validateJobRecord({ ...job(), attempts: 1.5 }).ok).toBe(false);
    expect(validateJobRecord({ ...job(), attempts: "1" }).ok).toBe(false);
  });

  it("accepts null nullable fields but rejects wrong types", () => {
    expect(validateJobRecord({ ...job(), resetAt: null, lastError: null, lastOutputTail: null }).ok).toBe(true);
    expect(validateJobRecord({ ...job(), resetAt: 123 }).ok).toBe(false);
    expect(validateJobRecord({ ...job(), lastError: {} }).ok).toBe(false);
  });

  it("preserves well-formed lastRateLimit provenance", () => {
    const detection = {
      pattern: "clock-time-meridiem",
      rawMatch: "reset at 5pm",
      resetAt: "2026-07-13T21:00:00.000Z",
      detectedAt: "2026-07-13T18:00:00.000Z",
    };
    const result = validateJobRecord({ ...job(), lastRateLimit: detection });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.job.lastRateLimit).toEqual(detection);
  });

  it("drops malformed or absent lastRateLimit instead of rejecting the record", () => {
    for (const bad of [
      undefined,
      null,
      {},
      { pattern: "x" },
      { pattern: 1, rawMatch: "y", resetAt: "z", detectedAt: "t" },
    ]) {
      const result = validateJobRecord({ ...job(), lastRateLimit: bad });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.job.lastRateLimit).toBeUndefined();
    }
  });
});

describe("parseImportJobs (json)", () => {
  it("round-trips a jobsToJson payload", () => {
    const jobs = [job(), job({ status: "failed" })];
    const parsed = parseImportJobs(jobsToJson(jobs), "json");
    expect(parsed.errors).toEqual([]);
    expect(parsed.jobs).toEqual(jobs);
  });

  it("reports a single error for a non-array root", () => {
    const parsed = parseImportJobs(JSON.stringify({ not: "an array" }), "json");
    expect(parsed.jobs).toEqual([]);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].reason).toMatch(/not a JSON array/);
  });

  it("reports invalid JSON without throwing", () => {
    const parsed = parseImportJobs("{ broken", "json");
    expect(parsed.jobs).toEqual([]);
    expect(parsed.errors[0].reason).toMatch(/invalid JSON/);
  });

  it("keeps valid records and flags bad ones by index", () => {
    const good = job();
    const payload = JSON.stringify([good, { id: "" }, { ...job(), tool: "nope" }]);
    const parsed = parseImportJobs(payload, "json");
    expect(parsed.jobs).toEqual([good]);
    expect(parsed.errors.map((e) => e.index)).toEqual([1, 2]);
    expect(parsed.errors.every((e) => e.kind === "index")).toBe(true);
  });
});

describe("parseImportJobs (ndjson)", () => {
  it("round-trips a jobsToNdjson payload", () => {
    const jobs = [job(), job({ status: "cancelled" })];
    const parsed = parseImportJobs(jobsToNdjson(jobs), "ndjson");
    expect(parsed.errors).toEqual([]);
    expect(parsed.jobs).toEqual(jobs);
  });

  it("skips blank lines and tolerates trailing newline", () => {
    const parsed = parseImportJobs(`${jobsToNdjson([job()])}\n\n`, "ndjson");
    expect(parsed.jobs).toHaveLength(1);
    expect(parsed.errors).toEqual([]);
  });

  it("records a bad line by 1-based line number and continues", () => {
    const good = job();
    const text = ["{ not json", JSON.stringify(good)].join("\n");
    const parsed = parseImportJobs(text, "ndjson");
    expect(parsed.jobs).toEqual([good]);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].index).toBe(1);
    expect(parsed.errors[0].kind).toBe("line");
  });
});

describe("planImport", () => {
  it("adds brand-new terminal jobs", () => {
    const plan = planImport([], [job(), job({ status: "failed" })]);
    expect(plan.toAdd).toHaveLength(2);
    expect(plan.toUpdate).toEqual([]);
    expect(plan.skippedExisting).toEqual([]);
    expect(plan.skippedActive).toEqual([]);
  });

  it("skips active jobs by default", () => {
    const active = ACTIVE_IMPORT_STATUSES.map((status) => job({ status }));
    const plan = planImport([], active);
    expect(plan.toAdd).toEqual([]);
    expect(plan.skippedActive).toHaveLength(active.length);
  });

  it("includes active jobs when opted in", () => {
    const active = job({ status: "waiting_for_reset" });
    const plan = planImport([], [active], { includeActive: true });
    expect(plan.toAdd).toEqual([active]);
    expect(plan.skippedActive).toEqual([]);
  });

  it("skips existing ids without overwrite", () => {
    const existing = job({ id: "dup" });
    const incoming = job({ id: "dup", project: "changed" });
    const plan = planImport([existing], [incoming]);
    expect(plan.toAdd).toEqual([]);
    expect(plan.toUpdate).toEqual([]);
    expect(plan.skippedExisting).toEqual([incoming]);
  });

  it("overwrites existing ids when asked", () => {
    const existing = job({ id: "dup" });
    const incoming = job({ id: "dup", project: "changed" });
    const plan = planImport([existing], [incoming], { overwrite: true });
    expect(plan.toUpdate).toEqual([incoming]);
    expect(plan.skippedExisting).toEqual([]);
  });

  it("treats an in-batch duplicate id as a collision (last wins on overwrite)", () => {
    const first = job({ id: "same", project: "a" });
    const second = job({ id: "same", project: "b" });
    const noOverwrite = planImport([], [first, second]);
    expect(noOverwrite.toAdd).toEqual([first]);
    expect(noOverwrite.skippedExisting).toEqual([second]);

    const overwrite = planImport([], [first, second], { overwrite: true });
    expect(overwrite.toAdd).toEqual([first]);
    expect(overwrite.toUpdate).toEqual([second]);
  });
});

describe("summarizeImportPlan", () => {
  it("flattens a plan into counts", () => {
    const plan = {
      toAdd: [job(), job()],
      toUpdate: [job()],
      skippedExisting: [job()],
      skippedActive: [job(), job(), job()],
    };
    expect(summarizeImportPlan(plan)).toEqual({
      added: 2,
      updated: 1,
      skippedExisting: 1,
      skippedActive: 3,
    });
  });
});
