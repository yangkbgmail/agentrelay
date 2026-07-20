import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayQueue } from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectImportFormat, exportStore, importStore, listStatus } from "../src/commands.js";

describe("importStore", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-import-test-"));
    storePath = join(dir, "jobs.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Write a source store, export it to a file, and return that file path. */
  function seedExport(format: "json" | "ndjson"): string {
    const srcPath = join(dir, "src.json");
    const src = new RelayQueue(srcPath);
    src.enqueue({ project: "alpha", tool: "claude-code", command: ["claude", "-p", "go"], cwd: "/a" });
    src.enqueue({ project: "beta", tool: "codex-cli", command: ["codex", "run"], cwd: "/b" });
    src.close();
    const jobs = listStatus(srcPath);
    const out = join(dir, `export.${format}`);
    exportStore({ storePath: srcPath, format, jobs, outPath: out });
    return out;
  }

  it("detects the format from the file extension", () => {
    expect(detectImportFormat("/tmp/a.ndjson")).toBe("ndjson");
    expect(detectImportFormat("/tmp/a.json")).toBe("json");
    expect(detectImportFormat("/tmp/a.NDJSON")).toBe("ndjson");
    expect(detectImportFormat("/tmp/whatever")).toBe("json");
  });

  it("imports an exported JSON file into an empty store", () => {
    const file = seedExport("json");
    const result = importStore({ storePath, inPath: file });
    expect(result.format).toBe("json");
    expect(result.parsed).toBe(2);
    expect(result.plan.added).toHaveLength(2);
    expect(result.dryRun).toBe(false);
    expect(result.wrote).toBe(true);
    expect(listStatus(storePath)).toHaveLength(2);
  });

  it("round-trips through NDJSON", () => {
    const file = seedExport("ndjson");
    const result = importStore({ storePath, inPath: file });
    expect(result.format).toBe("ndjson");
    expect(result.plan.added).toHaveLength(2);
    expect(
      listStatus(storePath)
        .map((j) => j.project)
        .sort()
    ).toEqual(["alpha", "beta"]);
  });

  it("skips colliding ids by default and reports a no-op write", () => {
    const file = seedExport("json");
    importStore({ storePath, inPath: file }); // first import populates the store
    const again = importStore({ storePath, inPath: file }); // second import collides on every id
    expect(again.plan.added).toHaveLength(0);
    expect(again.plan.skipped).toHaveLength(2);
    expect(again.dryRun).toBe(false); // caller didn't request a dry run
    expect(again.wrote).toBe(false); // but nothing was added/updated, so no write
    expect(listStatus(storePath)).toHaveLength(2);
  });

  it("overwrites colliding ids under the overwrite strategy", () => {
    const file = seedExport("json");
    importStore({ storePath, inPath: file });
    const result = importStore({ storePath, inPath: file, strategy: "overwrite" });
    expect(result.plan.updated).toHaveLength(2);
    expect(result.dryRun).toBe(false);
  });

  it("dry run does not write to the store", () => {
    const file = seedExport("json");
    const result = importStore({ storePath, inPath: file, dryRun: true });
    expect(result.plan.added).toHaveLength(2);
    expect(result.dryRun).toBe(true);
    expect(result.wrote).toBe(false);
    expect(listStatus(storePath)).toHaveLength(0);
  });

  it("collects invalid records and imports the valid ones", () => {
    const file = join(dir, "mixed.ndjson");
    const good = {
      id: "good-1",
      project: "p",
      tool: "claude-code",
      command: ["claude"],
      cwd: "/x",
      status: "completed",
      resetAt: null,
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
      attempts: 0,
      lastError: null,
      lastOutputTail: null,
    };
    writeFileSync(file, `${JSON.stringify(good)}\n{"id":"bad","status":"nope"}\n`, "utf8");
    const result = importStore({ storePath, inPath: file });
    expect(result.parsed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.plan.added).toHaveLength(1);
    expect(listStatus(storePath)).toHaveLength(1);
  });

  it("throws on a JSON file whose root is not an array", () => {
    const file = join(dir, "obj.json");
    writeFileSync(file, JSON.stringify({ not: "an array" }), "utf8");
    expect(() => importStore({ storePath, inPath: file })).toThrow(/must be an array/);
  });
});
