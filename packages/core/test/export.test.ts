import { describe, expect, it } from "vitest";
import {
  EXPORT_FORMATS,
  escapeCsvField,
  exportJobs,
  JOB_CSV_COLUMNS,
  jobCsvValue,
  jobsToCsv,
  jobsToJson,
} from "../src/export.js";
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

describe("escapeCsvField", () => {
  it("leaves plain values untouched", () => {
    expect(escapeCsvField("hello")).toBe("hello");
    expect(escapeCsvField("")).toBe("");
    expect(escapeCsvField("a b c")).toBe("a b c");
  });

  it("quotes fields containing a comma", () => {
    expect(escapeCsvField("a,b")).toBe('"a,b"');
  });

  it("quotes and doubles embedded double quotes", () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes fields containing newlines (LF and CR)", () => {
    expect(escapeCsvField("line1\nline2")).toBe('"line1\nline2"');
    expect(escapeCsvField("line1\r\nline2")).toBe('"line1\r\nline2"');
  });
});

describe("jobCsvValue", () => {
  it("stringifies numeric attempts", () => {
    expect(jobCsvValue(job({ attempts: 3 }), "attempts")).toBe("3");
  });

  it("space-joins the command array", () => {
    expect(jobCsvValue(job({ command: ["claude", "-p", "keep going"] }), "command")).toBe("claude -p keep going");
  });

  it("renders null resetAt/lastError as empty strings", () => {
    const j = job({ resetAt: null, lastError: null });
    expect(jobCsvValue(j, "resetAt")).toBe("");
    expect(jobCsvValue(j, "lastError")).toBe("");
  });

  it("passes plain string columns through", () => {
    const j = job({ id: "abc", project: "myproj", tool: "codex-cli", status: "failed", cwd: "/work" });
    expect(jobCsvValue(j, "id")).toBe("abc");
    expect(jobCsvValue(j, "project")).toBe("myproj");
    expect(jobCsvValue(j, "tool")).toBe("codex-cli");
    expect(jobCsvValue(j, "status")).toBe("failed");
    expect(jobCsvValue(j, "cwd")).toBe("/work");
  });
});

describe("jobsToCsv", () => {
  it("emits just the header row for an empty store", () => {
    expect(jobsToCsv([])).toBe(JOB_CSV_COLUMNS.join(","));
  });

  it("emits nothing when both empty and header:false", () => {
    expect(jobsToCsv([], { header: false })).toBe("");
  });

  it("emits a header plus one row per job", () => {
    const csv = jobsToCsv([
      job({ id: "j1", project: "p1", attempts: 2 }),
      job({ id: "j2", project: "p2", status: "failed" }),
    ]);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(JOB_CSV_COLUMNS.join(","));
    expect(lines[1].startsWith("j1,p1,claude-code,completed,2,")).toBe(true);
    expect(lines[2].startsWith("j2,p2,claude-code,failed,1,")).toBe(true);
  });

  it("escapes commas and quotes inside fields so columns stay aligned", () => {
    const csv = jobsToCsv([job({ command: ["claude", "-p", "refactor, please"], lastError: 'boom "x"' })], {
      header: false,
    });
    expect(csv).toContain('"claude -p refactor, please"');
    expect(csv).toContain('"boom ""x"""');
    // The escaped field must not introduce a stray column break.
    expect(csv.split("\n")).toHaveLength(1);
  });

  it("honors a custom column subset and order", () => {
    const csv = jobsToCsv([job({ id: "x", status: "queued" })], { columns: ["status", "id"] });
    expect(csv).toBe("status,id\nqueued,x");
  });
});

describe("jobsToJson", () => {
  it("round-trips losslessly, preserving the command array", () => {
    const jobs = [job({ command: ["claude", "-p", "a b"], lastOutputTail: "tail" })];
    const parsed = JSON.parse(jobsToJson(jobs));
    expect(parsed).toEqual(jobs);
    expect(parsed[0].command).toEqual(["claude", "-p", "a b"]);
  });

  it("pretty-prints with two-space indent", () => {
    expect(jobsToJson([job()])).toContain("\n  {");
  });
});

describe("exportJobs", () => {
  it("dispatches to CSV by default format", () => {
    const jobs = [job({ id: "d" })];
    expect(exportJobs(jobs, "csv")).toBe(jobsToCsv(jobs));
  });

  it("dispatches to JSON", () => {
    const jobs = [job({ id: "d" })];
    expect(exportJobs(jobs, "json")).toBe(jobsToJson(jobs));
  });

  it("exposes the supported formats", () => {
    expect(EXPORT_FORMATS).toEqual(["csv", "json"]);
  });
});
