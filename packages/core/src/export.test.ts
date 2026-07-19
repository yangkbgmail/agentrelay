import { describe, expect, it } from "vitest";
import { CSV_COLUMNS, escapeCsvField, serializeJobs, toCsv, toJsonArray, toNdjson } from "./export.js";
import type { AgentTool, JobStatus, RelayJob } from "./types.js";

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
    expect(escapeCsvField("2026-07-13T00:00:00.000Z")).toBe("2026-07-13T00:00:00.000Z");
  });

  it("quotes and doubles embedded quotes", () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes values containing commas", () => {
    expect(escapeCsvField("a,b,c")).toBe('"a,b,c"');
  });

  it("quotes values containing newlines (CR/LF)", () => {
    expect(escapeCsvField("line1\nline2")).toBe('"line1\nline2"');
    expect(escapeCsvField("line1\r\nline2")).toBe('"line1\r\nline2"');
  });
});

describe("toCsv", () => {
  it("emits a header row even for an empty list", () => {
    const csv = toCsv([]);
    expect(csv).toBe(`${CSV_COLUMNS.join(",")}\r\n`);
  });

  it("renders one CRLF-terminated row per job with a JSON command cell", () => {
    const csv = toCsv([job({ id: "a1", project: "web", attempts: 3 })]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    // id,project,tool,status,resetAt,createdAt,updatedAt,attempts,lastError,cwd,command
    expect(lines[1]).toBe(
      'a1,web,claude-code,completed,,2026-07-13T00:00:00.000Z,2026-07-13T00:00:00.000Z,3,,/tmp,"[""claude"",""-p"",""go""]"'
    );
    // Trailing EOL produces a final empty segment.
    expect(lines[2]).toBe("");
  });

  it("renders nullable fields (resetAt, lastError) as empty cells", () => {
    const csv = toCsv([job({ resetAt: null, lastError: null })]);
    const row = csv.split("\r\n")[1].split(",");
    expect(row[4]).toBe(""); // resetAt
    expect(row[8]).toBe(""); // lastError
  });

  it("escapes a project name and error text containing commas/quotes", () => {
    const csv = toCsv([job({ project: "a,b", lastError: 'boom "x"' })]);
    const line = csv.split("\r\n")[1];
    expect(line).toContain('"a,b"');
    expect(line).toContain('"boom ""x"""');
  });

  it("accepts a custom EOL", () => {
    const csv = toCsv([job({ id: "z" })], "\n");
    expect(csv).not.toContain("\r");
    expect(csv.endsWith("\n")).toBe(true);
    expect(csv.split("\n")[0]).toBe(CSV_COLUMNS.join(","));
  });
});

describe("toNdjson", () => {
  it("returns an empty string for no jobs", () => {
    expect(toNdjson([])).toBe("");
  });

  it("emits one JSON object per line, trailing newline included", () => {
    const out = toNdjson([job({ id: "a" }), job({ id: "b" })]);
    const lines = out.split("\n");
    expect(lines).toHaveLength(3); // two jobs + trailing empty
    expect(lines[2]).toBe("");
    expect(JSON.parse(lines[0]).id).toBe("a");
    expect(JSON.parse(lines[1]).id).toBe("b");
  });

  it("round-trips a full job object per line", () => {
    const j = job({ id: "keep", command: ["a", "b c"], lastOutputTail: "tail\nend" });
    const parsed = JSON.parse(toNdjson([j]).trim());
    expect(parsed).toEqual(j);
  });
});

describe("toJsonArray", () => {
  it("returns a pretty-printed array", () => {
    const out = toJsonArray([job({ id: "x" })]);
    expect(out.startsWith("[")).toBe(true);
    expect(JSON.parse(out)).toHaveLength(1);
    expect(out).toContain("\n  "); // 2-space indentation
  });

  it("returns [] for an empty list", () => {
    expect(toJsonArray([])).toBe("[]");
  });
});

describe("serializeJobs", () => {
  const jobs = [job({ id: "one" }), job({ id: "two" })];

  it("dispatches to CSV", () => {
    expect(serializeJobs(jobs, "csv")).toBe(toCsv(jobs));
  });

  it("dispatches to NDJSON", () => {
    expect(serializeJobs(jobs, "ndjson")).toBe(toNdjson(jobs));
  });

  it("dispatches to JSON", () => {
    expect(serializeJobs(jobs, "json")).toBe(toJsonArray(jobs));
  });
});
