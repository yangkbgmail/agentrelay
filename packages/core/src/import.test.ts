import { describe, expect, it } from "vitest";
import {
  IMPORT_FORMATS,
  IMPORT_STRATEGIES,
  type ImportStrategy,
  parseImportContent,
  planImport,
  validateJobRecord,
} from "./import.js";
import type { RelayJob } from "./types.js";

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "id-1",
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status: "completed",
    resetAt: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T01:00:00.000Z",
    attempts: 2,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("validateJobRecord", () => {
  it("accepts a well-formed job", () => {
    expect(validateJobRecord(job())).toBeNull();
  });

  it("accepts optional fields as strings when present", () => {
    expect(
      validateJobRecord(job({ resetAt: "2026-07-20T02:00:00.000Z", lastError: "boom", lastOutputTail: "tail" }))
    ).toBeNull();
  });

  it.each([
    ["non-object", 42, "not a JSON object"],
    ["array", [], "not a JSON object"],
    ["null", null, "not a JSON object"],
  ])("rejects %s", (_label, value, reason) => {
    expect(validateJobRecord(value)).toBe(reason);
  });

  it("rejects a missing id", () => {
    const { id, ...rest } = job();
    expect(validateJobRecord(rest)).toMatch(/id/);
  });

  it("rejects an unknown tool", () => {
    expect(validateJobRecord(job({ tool: "gpt-cli" as never }))).toMatch(/tool/);
  });

  it("rejects an unknown status", () => {
    expect(validateJobRecord(job({ status: "paused" as never }))).toMatch(/status/);
  });

  it("rejects a non-array command", () => {
    expect(validateJobRecord({ ...job(), command: "claude -p" })).toMatch(/command/);
  });

  it("rejects a command with non-string members", () => {
    expect(validateJobRecord({ ...job(), command: ["claude", 3] })).toMatch(/command/);
  });

  it("rejects a non-finite attempts", () => {
    expect(validateJobRecord({ ...job(), attempts: Number.NaN })).toMatch(/attempts/);
  });

  it("rejects a numeric resetAt", () => {
    expect(validateJobRecord({ ...job(), resetAt: 123 })).toMatch(/resetAt/);
  });
});

describe("parseImportContent — json", () => {
  it("parses an array of jobs", () => {
    const content = JSON.stringify([job({ id: "a" }), job({ id: "b" })]);
    const result = parseImportContent(content, "json");
    expect(result.jobs.map((j) => j.id)).toEqual(["a", "b"]);
    expect(result.errors).toHaveLength(0);
  });

  it("collects per-record errors and keeps the good ones", () => {
    const content = JSON.stringify([job({ id: "ok" }), { ...job({ id: "bad" }), status: "nope" }]);
    const result = parseImportContent(content, "json");
    expect(result.jobs.map((j) => j.id)).toEqual(["ok"]);
    expect(result.errors).toEqual([{ index: 1, message: expect.stringMatching(/status/) }]);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseImportContent("{not json", "json")).toThrow(/invalid JSON/);
  });

  it("throws when the JSON root is not an array", () => {
    expect(() => parseImportContent(JSON.stringify(job()), "json")).toThrow(/must be an array/);
  });

  it("strips unknown fields to a clean job", () => {
    const content = JSON.stringify([{ ...job({ id: "x" }), bogus: "field" }]);
    const result = parseImportContent(content, "json");
    expect(result.jobs[0]).not.toHaveProperty("bogus");
    expect(result.jobs[0].id).toBe("x");
  });
});

describe("parseImportContent — ndjson", () => {
  it("parses one job per line and tolerates blank/trailing lines", () => {
    const content = `${JSON.stringify(job({ id: "a" }))}\n\n${JSON.stringify(job({ id: "b" }))}\n`;
    const result = parseImportContent(content, "ndjson");
    expect(result.jobs.map((j) => j.id)).toEqual(["a", "b"]);
    expect(result.errors).toHaveLength(0);
  });

  it("indexes errors by non-blank record position", () => {
    const content = `${JSON.stringify(job({ id: "a" }))}\n{bad line\n${JSON.stringify(job({ id: "c" }))}`;
    const result = parseImportContent(content, "ndjson");
    expect(result.jobs.map((j) => j.id)).toEqual(["a", "c"]);
    expect(result.errors).toEqual([{ index: 1, message: expect.stringMatching(/invalid JSON/) }]);
  });

  it("returns nothing for an empty document", () => {
    expect(parseImportContent("\n\n", "ndjson")).toEqual({ jobs: [], errors: [] });
  });
});

describe("planImport", () => {
  it("adds jobs with new ids", () => {
    const plan = planImport([job({ id: "a" })], [job({ id: "b" }), job({ id: "c" })]);
    expect(plan.added.map((j) => j.id)).toEqual(["b", "c"]);
    expect(plan.updated).toHaveLength(0);
    expect(plan.skipped).toHaveLength(0);
    expect(plan.merged.map((j) => j.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("skips colliding ids by default", () => {
    const existing = [job({ id: "a", project: "old" })];
    const plan = planImport(existing, [job({ id: "a", project: "new" })]);
    expect(plan.skipped.map((j) => j.id)).toEqual(["a"]);
    expect(plan.added).toHaveLength(0);
    expect(plan.merged.find((j) => j.id === "a")?.project).toBe("old");
  });

  it("overwrites colliding ids under the overwrite strategy", () => {
    const existing = [job({ id: "a", project: "old" })];
    const plan = planImport(existing, [job({ id: "a", project: "new" })], "overwrite");
    expect(plan.updated.map((j) => j.id)).toEqual(["a"]);
    expect(plan.skipped).toHaveLength(0);
    expect(plan.merged.find((j) => j.id === "a")?.project).toBe("new");
  });

  it("does not mutate its inputs", () => {
    const existing = [job({ id: "a", project: "old" })];
    const incoming = [job({ id: "a", project: "new" })];
    planImport(existing, incoming, "overwrite");
    expect(existing[0].project).toBe("old");
    expect(incoming[0].project).toBe("new");
  });

  it("lets the last duplicate in incoming win for a new id", () => {
    const plan = planImport([], [job({ id: "d", project: "first" }), job({ id: "d", project: "second" })]);
    expect(plan.added).toHaveLength(1);
    expect(plan.added[0].project).toBe("second");
    expect(plan.merged).toHaveLength(1);
  });

  it("exposes the format and strategy constants", () => {
    expect(IMPORT_FORMATS).toEqual(["json", "ndjson"]);
    expect(IMPORT_STRATEGIES).toEqual(["skip", "overwrite"]);
    const strategies: ImportStrategy[] = [...IMPORT_STRATEGIES];
    expect(strategies).toContain("skip");
  });
});
