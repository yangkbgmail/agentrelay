import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayJob } from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeExportFile } from "../src/commands.js";
import { EXPORT_FORMATS, isExportFormat, renderExport } from "../src/export.js";

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "abcdef1234567890",
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status: "completed",
    resetAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("isExportFormat", () => {
  it("accepts the known formats and rejects others", () => {
    for (const f of EXPORT_FORMATS) expect(isExportFormat(f)).toBe(true);
    expect(isExportFormat("csv")).toBe(true);
    expect(isExportFormat("json")).toBe(true);
    expect(isExportFormat("xml")).toBe(false);
    expect(isExportFormat("")).toBe(false);
  });
});

describe("renderExport", () => {
  it("produces CSV with a header row", () => {
    const out = renderExport([job({ id: "x", project: "web" })], "csv");
    const rows = out.split("\r\n");
    expect(rows[0]).toContain("id,project,tool,status");
    expect(rows[1].startsWith("x,web,")).toBe(true);
  });

  it("produces a JSON array", () => {
    const out = renderExport([job({ id: "x" })], "json");
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("x");
  });

  it("handles an empty job list per format", () => {
    expect(renderExport([], "csv").split("\r\n")).toHaveLength(1); // header only
    expect(JSON.parse(renderExport([], "json"))).toEqual([]);
  });
});

describe("writeExportFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-export-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes content to the given path and returns it", () => {
    const path = join(dir, "out.csv");
    const returned = writeExportFile(path, "a,b\r\n1,2");
    expect(returned).toBe(path);
    expect(readFileSync(path, "utf8")).toBe("a,b\r\n1,2");
  });

  it("creates missing parent directories", () => {
    const path = join(dir, "deep", "nested", "out.json");
    writeExportFile(path, "[]");
    expect(readFileSync(path, "utf8")).toBe("[]");
  });
});
