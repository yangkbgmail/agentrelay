import type { ImportParseError } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { type ImportJsonInput, renderImportJson } from "../src/import.js";

const GENERATED_AT = "2026-08-23T00:00:00.000Z";

function outcome(overrides: Partial<ImportJsonInput> = {}): ImportJsonInput {
  return {
    added: 0,
    updated: 0,
    skippedExisting: 0,
    skippedActive: 0,
    parseErrors: [],
    dryRun: false,
    ...overrides,
  };
}

describe("renderImportJson", () => {
  it("wraps the outcome in the shared { storePath, generatedAt } envelope", () => {
    const parsed = JSON.parse(renderImportJson(outcome({ added: 3 }), "/tmp/jobs.json", GENERATED_AT));
    expect(parsed.storePath).toBe("/tmp/jobs.json");
    expect(parsed.generatedAt).toBe(GENERATED_AT);
    expect(parsed.added).toBe(3);
  });

  it("carries every merge count and the dryRun flag", () => {
    const parsed = JSON.parse(
      renderImportJson(
        outcome({ added: 2, updated: 1, skippedExisting: 4, skippedActive: 5, dryRun: true }),
        "/tmp/jobs.json",
        GENERATED_AT
      )
    );
    expect(parsed).toMatchObject({
      added: 2,
      updated: 1,
      skippedExisting: 4,
      skippedActive: 5,
      dryRun: true,
    });
  });

  it("passes parse errors through verbatim so a bad dump is diagnosable from JSON alone", () => {
    const parseErrors: ImportParseError[] = [
      { index: 4, kind: "line", reason: "invalid JSON (Unexpected end of input)" },
      { index: 7, kind: "line", reason: "`command` must not be empty" },
    ];
    const parsed = JSON.parse(renderImportJson(outcome({ parseErrors }), "/tmp/jobs.json", GENERATED_AT));
    expect(parsed.parseErrors).toHaveLength(2);
    expect(parsed.parseErrors[0]).toEqual({ index: 4, kind: "line", reason: "invalid JSON (Unexpected end of input)" });
    expect(parsed.parseErrors[1].reason).toBe("`command` must not be empty");
  });

  it("emits an empty parseErrors array (not omitted) for a clean import", () => {
    const parsed = JSON.parse(renderImportJson(outcome({ added: 1 }), "/tmp/jobs.json", GENERATED_AT));
    expect(parsed.parseErrors).toEqual([]);
  });

  it("produces valid, pretty-printed JSON", () => {
    const out = renderImportJson(outcome({ added: 1 }), "/tmp/jobs.json", GENERATED_AT);
    expect(out).toContain("\n  "); // 2-space indent
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("defaults generatedAt to a real ISO timestamp when omitted", () => {
    const parsed = JSON.parse(renderImportJson(outcome(), "/tmp/jobs.json"));
    expect(() => new Date(parsed.generatedAt).toISOString()).not.toThrow();
    expect(parsed.generatedAt).toBe(new Date(parsed.generatedAt).toISOString());
  });
});
