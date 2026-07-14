import { describe, expect, it } from "vitest";
import { EXPORT_COLUMNS, escapeCsvField, jobsToCsv, jobsToJson } from "../src/export.js";
import type { AgentTool, JobStatus, RelayJob } from "../src/types.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "proj",
    tool: "claude-code" as AgentTool,
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "completed" as JobStatus,
    resetAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("escapeCsvField", () => {
  it("leaves plain values untouched", () => {
    expect(escapeCsvField("hello")).toBe("hello");
    expect(escapeCsvField("")).toBe("");
    expect(escapeCsvField("123")).toBe("123");
  });

  it("quotes and doubles internal quotes when a comma is present", () => {
    expect(escapeCsvField("a,b")).toBe('"a,b"');
  });

  it("quotes fields containing double quotes, doubling them", () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes fields containing newlines or carriage returns", () => {
    expect(escapeCsvField("line1\nline2")).toBe('"line1\nline2"');
    expect(escapeCsvField("a\r\nb")).toBe('"a\r\nb"');
  });
});

describe("jobsToCsv", () => {
  it("emits only a header row for an empty store", () => {
    const csv = jobsToCsv([]);
    expect(csv).toBe(EXPORT_COLUMNS.map((c) => c.header).join(","));
    // No trailing data rows.
    expect(csv.split("\r\n")).toHaveLength(1);
  });

  it("renders one CRLF-separated row per job with the expected columns", () => {
    const csv = jobsToCsv([
      job({
        id: "abc",
        project: "web",
        tool: "codex-cli",
        status: "waiting_for_reset",
        resetAt: "2026-07-14T00:00:00.000Z",
        attempts: 3,
        command: ["codex", "run"],
        cwd: "/work/web",
      }),
    ]);
    const rows = csv.split("\r\n");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe(
      "id,project,tool,status,resetAt,createdAt,updatedAt,attempts,command,cwd,lastError,lastOutputTail"
    );
    expect(rows[1]).toBe(
      "abc,web,codex-cli,waiting_for_reset,2026-07-14T00:00:00.000Z,2026-07-13T00:00:00.000Z,2026-07-13T00:00:00.000Z,3,codex run,/work/web,,"
    );
  });

  it("renders null resetAt/lastError/lastOutputTail as empty cells (not 'null')", () => {
    const csv = jobsToCsv([job({ id: "x", resetAt: null, lastError: null, lastOutputTail: null })]);
    const cells = csv.split("\r\n")[1].split(",");
    // resetAt is column index 4, lastError 10, lastOutputTail 11.
    expect(cells[4]).toBe("");
    expect(cells[10]).toBe("");
    expect(cells[11]).toBe("");
    expect(csv).not.toContain("null");
  });

  it("escapes commas, quotes, and newlines inside captured output", () => {
    const csv = jobsToCsv([job({ id: "y", lastError: 'boom: "x", then\nmore', command: ["sh", "-c", "echo a, b"] })]);
    // The whole row keeps the escaped multi-line field intact.
    expect(csv).toContain('"boom: ""x"", then\nmore"');
    // command joined with a space, then quoted because it contains a comma.
    expect(csv).toContain('"sh -c echo a, b"');
  });
});

describe("jobsToJson", () => {
  it("emits a pretty-printed array of the raw job records", () => {
    const jobs = [job({ id: "a" }), job({ id: "b" })];
    const parsed = JSON.parse(jobsToJson(jobs));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe("a");
    expect(parsed[1].id).toBe("b");
    // Round-trips as the exact records (no envelope).
    expect(parsed).toEqual(jobs);
  });

  it("returns an empty array for an empty store", () => {
    expect(JSON.parse(jobsToJson([]))).toEqual([]);
  });
});
