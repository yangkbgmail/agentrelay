import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayQueue, scopeJobs } from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportStore, listStatus } from "../src/commands.js";
import { selectJobs } from "../src/status.js";

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

  it("produces NDJSON with one JSON object per line that each round-trip", () => {
    seed();
    const result = exportStore({ storePath, format: "ndjson" });
    expect(result.count).toBe(2);
    const lines = result.content.split("\n");
    expect(lines).toHaveLength(2); // one record per line, no header, no blank tail
    const commands = lines.map((l) => (JSON.parse(l) as { command: string[] }).command);
    expect(commands).toContainEqual(["claude", "-p", "go"]);
    expect(commands).toContainEqual(["codex", "run"]);
  });

  it("writes NDJSON to a file with a trailing newline (POSIX text convention)", () => {
    seed();
    const out = join(dir, "sub", "jobs.ndjson");
    const result = exportStore({ storePath, format: "ndjson", outPath: out });
    expect(result.writtenTo).toBe(out);
    const onDisk = readFileSync(out, "utf8");
    expect(onDisk.endsWith("\n")).toBe(true);
    // Every non-empty line is an independently parseable job record.
    const records = onDisk.trimEnd().split("\n");
    expect(records).toHaveLength(2);
    for (const line of records) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
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

  it("produces a Markdown table with a header, separator, and one row per job", () => {
    seed();
    const result = exportStore({ storePath, format: "md" });
    expect(result.count).toBe(2);
    const lines = result.content.split("\n");
    expect(lines).toHaveLength(4); // header + separator + 2 rows
    expect(lines[0].startsWith("| id | project | tool | status |")).toBe(true);
    expect(lines[1]).toContain("| --- |");
    expect(lines[2].startsWith("| ")).toBe(true);
    expect(lines[2].endsWith(" |")).toBe(true);
  });

  it("honors a --columns subset/order for CSV", () => {
    seed();
    const result = exportStore({ storePath, format: "csv", columns: ["status", "project", "tool"] });
    const lines = result.content.split("\n");
    expect(lines[0]).toBe("status,project,tool");
    expect(lines).toHaveLength(3); // header + 2 rows
    // Each row now has exactly three columns, in the requested order.
    for (const row of lines.slice(1)) {
      expect(row.split(",")).toHaveLength(3);
    }
  });

  it("honors a --columns subset for the Markdown table", () => {
    seed();
    const result = exportStore({ storePath, format: "md", columns: ["id", "status"] });
    const lines = result.content.split("\n");
    expect(lines[0]).toBe("| id | status |");
    expect(lines[1]).toBe("| --- | --- |");
    expect(lines).toHaveLength(4); // header + separator + 2 rows
  });

  // The `export` command applies the same scope filters as `stats`/`status`:
  // the --since/--until time window via core scopeJobs, then
  // --status/--tool/--project/--sort/--reverse via selectJobs. These tests
  // exercise that exact pipeline feeding exportStore, matching the CLI wiring.
  it("exports only the jobs matching a --tool filter", () => {
    seed();
    const jobs = selectJobs(listStatus(storePath), { tools: ["codex-cli"] });
    const result = exportStore({ storePath, format: "json", jobs });
    const parsed = JSON.parse(result.content) as Array<{ tool: string; project: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].tool).toBe("codex-cli");
    expect(parsed[0].project).toBe("beta");
  });

  it("combines a --since time window with a --tool filter (window then select)", () => {
    const now = Date.now();
    const iso = (ms: number) => new Date(now - ms).toISOString();
    const base = {
      cwd: "/w",
      status: "completed" as const,
      resetAt: null,
      attempts: 1,
      lastError: null,
      lastOutputTail: null,
    };
    // Old codex job (created before the window) that also matches the tool —
    // it must be excluded by the time window even though the tool matches.
    const all = [
      {
        ...base,
        id: "old",
        project: "alpha",
        tool: "codex-cli" as const,
        command: ["codex", "old"],
        createdAt: iso(30 * 24 * 60 * 60 * 1000),
        updatedAt: iso(30 * 24 * 60 * 60 * 1000),
      },
      {
        ...base,
        id: "new",
        project: "beta",
        tool: "codex-cli" as const,
        command: ["codex", "new"],
        createdAt: iso(60 * 60 * 1000),
        updatedAt: iso(60 * 60 * 1000),
      },
      {
        ...base,
        id: "claude",
        project: "gamma",
        tool: "claude-code" as const,
        command: ["claude", "-p", "x"],
        createdAt: iso(60 * 60 * 1000),
        updatedAt: iso(60 * 60 * 1000),
      },
    ];

    const windowed = scopeJobs(all, { createdFrom: now - 24 * 60 * 60 * 1000 });
    const jobs = selectJobs(windowed, { tools: ["codex-cli"] });
    const result = exportStore({ storePath, format: "json", jobs });
    const parsed = JSON.parse(result.content) as Array<{ project: string; command: string[] }>;
    // Only the recent codex-cli job survives both the window and the tool filter.
    expect(parsed).toHaveLength(1);
    expect(parsed[0].project).toBe("beta");
    expect(parsed[0].command).toEqual(["codex", "new"]);
  });
});
