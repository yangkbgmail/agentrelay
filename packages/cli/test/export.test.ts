import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayQueue } from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportStore, listStatus } from "../src/commands.js";

describe("exportStore", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-export-test-"));
    storePath = join(dir, "jobs.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(): RelayQueue {
    const queue = new RelayQueue(storePath);
    queue.enqueue({ project: "alpha", tool: "claude-code", command: ["claude", "-p", "go"], cwd: "/a" });
    queue.enqueue({ project: "beta", tool: "codex-cli", command: ["codex", "run"], cwd: "/b" });
    queue.close();
    return queue;
  }

  it("reads the whole store when no jobs are passed", () => {
    seed();
    const result = exportStore({ storePath, format: "csv" });
    expect(result.count).toBe(2);
    expect(result.writtenTo).toBeNull();
    const lines = result.content.split("\n");
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[0]).toContain("id,project,tool,status");
  });

  it("serializes only the jobs it is given", () => {
    seed();
    const all = listStatus(storePath);
    const result = exportStore({ storePath, format: "csv", jobs: all.slice(0, 1) });
    expect(result.count).toBe(1);
    expect(result.content.split("\n")).toHaveLength(2); // header + 1 row
  });

  it("produces valid JSON that round-trips", () => {
    seed();
    const result = exportStore({ storePath, format: "json" });
    const parsed = JSON.parse(result.content);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    // Store order is newest-first and both jobs may share a createdAt
    // millisecond, so assert on the set of commands rather than a fixed index.
    const commands = parsed.map((j: { command: string[] }) => j.command);
    expect(commands).toContainEqual(["claude", "-p", "go"]);
    expect(commands).toContainEqual(["codex", "run"]);
  });

  it("writes to a file with a trailing newline and reports the path", () => {
    seed();
    const out = join(dir, "sub", "jobs.csv");
    const result = exportStore({ storePath, format: "csv", outPath: out });
    expect(result.writtenTo).toBe(out);
    const onDisk = readFileSync(out, "utf8");
    expect(onDisk.endsWith("\n")).toBe(true);
    expect(onDisk.trimEnd()).toBe(result.content);
  });

  it("exports just the CSV header for an empty store", () => {
    const result = exportStore({ storePath, format: "csv" });
    expect(result.count).toBe(0);
    expect(result.content.split("\n")).toHaveLength(1);
  });
});
