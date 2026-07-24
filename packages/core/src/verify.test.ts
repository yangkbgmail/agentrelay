import { describe, expect, it } from "vitest";
import type { RelayJob } from "./types.js";
import { verifyStore } from "./verify.js";

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/home/user/demo",
    status: "completed",
    resetAt: null,
    createdAt: "2026-07-24T10:00:00.000Z",
    updatedAt: "2026-07-24T10:05:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("verifyStore", () => {
  it("reports a clean store as ok with no issues", () => {
    const result = verifyStore([job({ id: "a" }), job({ id: "b", status: "failed" })]);
    expect(result.ok).toBe(true);
    expect(result.total).toBe(2);
    expect(result.validJobs).toBe(2);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
    expect(result.issues).toEqual([]);
  });

  it("treats an empty store as ok", () => {
    const result = verifyStore([]);
    expect(result).toEqual({ total: 0, validJobs: 0, errorCount: 0, warningCount: 0, ok: true, issues: [] });
  });

  it("flags a structurally invalid record as an error and skips its semantic checks", () => {
    const result = verifyStore([{ id: "x", project: "p", tool: "bogus" }]);
    expect(result.ok).toBe(false);
    expect(result.validJobs).toBe(0);
    expect(result.errorCount).toBe(1);
    expect(result.issues[0]).toMatchObject({ level: "error", index: 0, jobId: "x", code: "invalid-record" });
    // Only the structural error — no clock/reset warnings for an unvalidated record.
    expect(result.issues).toHaveLength(1);
  });

  it("attributes jobId=null when the invalid record has no string id", () => {
    const result = verifyStore([42]);
    expect(result.issues[0]).toMatchObject({ level: "error", code: "invalid-record", jobId: null, index: 0 });
  });

  it("flags an empty command as invalid (queue would carry an unspawnnable job)", () => {
    const result = verifyStore([job({ command: [] })]);
    expect(result.errorCount).toBe(1);
    expect(result.issues[0].code).toBe("invalid-record");
    expect(result.issues[0].message).toMatch(/command/);
  });

  it("detects a duplicate id and points at the earlier record", () => {
    const result = verifyStore([job({ id: "dup" }), job({ id: "other" }), job({ id: "dup", status: "failed" })]);
    expect(result.ok).toBe(false);
    expect(result.validJobs).toBe(3);
    const dup = result.issues.find((i) => i.code === "duplicate-id");
    expect(dup).toMatchObject({ level: "error", index: 2, jobId: "dup" });
    expect(dup?.message).toContain("record 0");
  });

  it("warns when a waiting_for_reset job has no resetAt", () => {
    const result = verifyStore([job({ status: "waiting_for_reset", resetAt: null })]);
    expect(result.ok).toBe(true); // warning, not error
    expect(result.warningCount).toBe(1);
    expect(result.issues[0]).toMatchObject({ level: "warning", code: "waiting-without-reset" });
  });

  it("does not warn when a waiting_for_reset job has a valid resetAt", () => {
    const result = verifyStore([job({ status: "waiting_for_reset", resetAt: "2026-07-24T12:00:00.000Z" })]);
    expect(result.issues).toEqual([]);
  });

  it("warns on an unparseable resetAt", () => {
    const result = verifyStore([job({ status: "waiting_for_reset", resetAt: "not-a-date" })]);
    expect(result.warningCount).toBe(1);
    expect(result.issues[0].code).toBe("unparseable-resetAt");
  });

  it("warns on unparseable createdAt/updatedAt", () => {
    const result = verifyStore([job({ createdAt: "nope", updatedAt: "also-nope" })]);
    const codes = result.issues.map((i) => i.code).sort();
    expect(codes).toEqual(["unparseable-createdAt", "unparseable-updatedAt"]);
    expect(result.errorCount).toBe(0);
  });

  it("warns on clock skew (updatedAt before createdAt)", () => {
    const result = verifyStore([job({ createdAt: "2026-07-24T10:05:00.000Z", updatedAt: "2026-07-24T10:00:00.000Z" })]);
    expect(result.warningCount).toBe(1);
    expect(result.issues[0].code).toBe("clock-skew");
  });

  it("does not raise clock skew when a timestamp is itself unparseable", () => {
    const result = verifyStore([job({ createdAt: "2026-07-24T10:05:00.000Z", updatedAt: "nope" })]);
    expect(result.issues.map((i) => i.code)).toEqual(["unparseable-updatedAt"]);
  });

  it("accumulates errors and warnings across many records in index order", () => {
    const result = verifyStore([
      job({ id: "ok" }),
      { id: "bad", tool: "claude-code" }, // invalid (missing fields) -> error
      job({ id: "dup" }),
      job({ id: "dup", status: "waiting_for_reset", resetAt: null }), // duplicate + warning
    ]);
    expect(result.total).toBe(4);
    expect(result.validJobs).toBe(3);
    expect(result.errorCount).toBe(2); // invalid-record + duplicate-id
    expect(result.warningCount).toBe(1); // waiting-without-reset
    expect(result.ok).toBe(false);
    // Issues stay ordered by record index.
    expect(result.issues.map((i) => i.index)).toEqual([1, 3, 3]);
  });

  it("flags negative attempts as an invalid record", () => {
    const result = verifyStore([job({ attempts: -1 })]);
    expect(result.errorCount).toBe(1);
    expect(result.issues[0].code).toBe("invalid-record");
  });
});
