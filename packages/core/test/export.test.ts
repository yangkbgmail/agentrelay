import { describe, expect, it } from "vitest";
import {
  EXPORT_FORMATS,
  escapeCsvField,
  escapeHtml,
  escapeMarkdownCell,
  exportJobs,
  JOB_CSV_COLUMNS,
  jobCsvValue,
  jobsToCsv,
  jobsToHtml,
  jobsToJson,
  jobsToMarkdown,
  jobsToNdjson,
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

describe("escapeMarkdownCell", () => {
  it("renders an empty value as an em dash", () => {
    expect(escapeMarkdownCell("")).toBe("—");
  });

  it("leaves plain values untouched", () => {
    expect(escapeMarkdownCell("hello")).toBe("hello");
    expect(escapeMarkdownCell("a b c")).toBe("a b c");
  });

  it("backslash-escapes pipes so they don't break the column", () => {
    expect(escapeMarkdownCell("a|b")).toBe("a\\|b");
  });

  it("escapes backslashes before pipes (so an escape isn't misread)", () => {
    expect(escapeMarkdownCell("a\\|b")).toBe("a\\\\\\|b");
  });

  it("collapses newlines to <br> to keep the row on one line", () => {
    expect(escapeMarkdownCell("line1\nline2")).toBe("line1<br>line2");
    expect(escapeMarkdownCell("line1\r\nline2")).toBe("line1<br>line2");
    expect(escapeMarkdownCell("line1\rline2")).toBe("line1<br>line2");
  });
});

describe("jobsToMarkdown", () => {
  it("emits header + separator rows for an empty store", () => {
    const md = jobsToMarkdown([]);
    const lines = md.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`| ${JOB_CSV_COLUMNS.join(" | ")} |`);
    expect(lines[1]).toBe(`| ${JOB_CSV_COLUMNS.map(() => "---").join(" | ")} |`);
  });

  it("emits one row per job with piped cells", () => {
    const md = jobsToMarkdown([job({ id: "j1", project: "p1", attempts: 2 })]);
    const lines = md.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2].startsWith("| j1 | p1 | claude-code | completed | 2 |")).toBe(true);
  });

  it("escapes pipes and newlines so a cell never breaks the table", () => {
    const md = jobsToMarkdown([job({ command: ["claude", "-p", "a | b"], lastError: "boom\nnext" })], {});
    const lines = md.split("\n");
    // Still exactly header + separator + one data row.
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("claude -p a \\| b");
    expect(lines[2]).toContain("boom<br>next");
  });

  it("renders null resetAt/lastError cells as em dashes", () => {
    const md = jobsToMarkdown([job({ resetAt: null, lastError: null })]);
    const row = md.split("\n")[2];
    expect(row).toContain("| — |");
  });

  it("honors a custom column subset and order", () => {
    const md = jobsToMarkdown([job({ id: "x", status: "queued" })], { columns: ["status", "id"] });
    expect(md).toBe("| status | id |\n| --- | --- |\n| queued | x |");
  });
});

describe("jobsToNdjson", () => {
  it("emits one compact JSON object per line, LF-separated, no trailing newline", () => {
    const jobs = [job({ id: "a" }), job({ id: "b" }), job({ id: "c" })];
    const out = jobsToNdjson(jobs);
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    // Compact (no pretty-print indentation) so each record is exactly one line.
    expect(out).not.toContain("\n  ");
    expect(out.endsWith("\n")).toBe(false);
    expect(lines.map((l) => JSON.parse(l).id)).toEqual(["a", "b", "c"]);
  });

  it("round-trips each line losslessly, preserving the command array", () => {
    const jobs = [job({ command: ["claude", "-p", "a b"], lastOutputTail: "tail" })];
    const parsed = jobsToNdjson(jobs)
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(parsed).toEqual(jobs);
    expect(parsed[0].command).toEqual(["claude", "-p", "a b"]);
  });

  it("keeps newline-bearing fields on a single line (embedded LF is escaped)", () => {
    const out = jobsToNdjson([job({ lastError: "line1\nline2" })]);
    // The record's own newline is JSON-escaped, so it does not split the record.
    expect(out.split("\n")).toHaveLength(1);
    expect(JSON.parse(out).lastError).toBe("line1\nline2");
  });

  it("yields an empty string for an empty job list", () => {
    expect(jobsToNdjson([])).toBe("");
  });
});

describe("escapeHtml", () => {
  it("leaves plain values untouched", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
    expect(escapeHtml("")).toBe("");
  });

  it("escapes the five markup-significant characters", () => {
    expect(escapeHtml('<a href="x">&y\'z</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;y&#39;z&lt;/a&gt;");
  });

  it("escapes ampersand before the others so entities aren't double-escaped", () => {
    expect(escapeHtml("a & <b>")).toBe("a &amp; &lt;b&gt;");
  });
});

describe("jobsToHtml", () => {
  it("emits a self-contained HTML document with inlined styles", () => {
    const html = jobsToHtml([job({ id: "j1" })]);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
    expect(html).toContain("<style>");
    // No external assets — a single self-contained file.
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
  });

  it("renders one table row per job with all columns as headers", () => {
    const html = jobsToHtml([job({ id: "j1", project: "web" }), job({ id: "j2", project: "api" })]);
    for (const col of JOB_CSV_COLUMNS) {
      expect(html).toContain(`<th>${col}</th>`);
    }
    expect(html).toContain("j1");
    expect(html).toContain("j2");
    expect(html).toContain("web");
    expect(html).toContain("api");
    // Two data rows (each opens with <tr> inside <tbody>).
    expect((html.match(/<tr>/g) ?? []).length).toBe(3); // 1 header + 2 body
  });

  it("renders status as a colored badge", () => {
    const html = jobsToHtml([job({ status: "failed" })]);
    expect(html).toContain('<span class="badge badge-failed">failed</span>');
  });

  it("escapes cell content so prompts with markup stay literal", () => {
    const html = jobsToHtml([job({ command: ["claude", "-p", "<script>alert(1)</script>"], lastError: "a & b" })]);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("a &amp; b");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("shows a status breakdown summary derived purely from the jobs", () => {
    const html = jobsToHtml([job({ status: "completed" }), job({ status: "completed" }), job({ status: "failed" })]);
    expect(html).toContain("3 job(s)");
    expect(html).toContain("completed: 2");
    expect(html).toContain("failed: 1");
  });

  it("still produces a valid document with an empty note for no jobs", () => {
    const html = jobsToHtml([]);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("0 job(s)");
    expect(html).toContain("No jobs to show.");
    expect(html).toContain(`colspan="${JOB_CSV_COLUMNS.length}"`);
  });

  it("honors a custom title and escapes it", () => {
    const html = jobsToHtml([], { title: "My <Relay> Report" });
    expect(html).toContain("<title>My &lt;Relay&gt; Report</title>");
    expect(html).toContain("<h1>My &lt;Relay&gt; Report</h1>");
  });

  it("respects a custom column selection", () => {
    const html = jobsToHtml([job({ id: "x", status: "queued" })], { columns: ["status", "id"] });
    const headerBlock = html.slice(html.indexOf("<thead>"), html.indexOf("</thead>"));
    expect(headerBlock).toContain("<th>status</th>");
    expect(headerBlock).toContain("<th>id</th>");
    expect(headerBlock).not.toContain("<th>project</th>");
  });

  it("is deterministic (no embedded clock)", () => {
    const jobs = [job({ id: "same" })];
    expect(jobsToHtml(jobs)).toBe(jobsToHtml(jobs));
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

  it("dispatches to Markdown", () => {
    const jobs = [job({ id: "d" })];
    expect(exportJobs(jobs, "md")).toBe(jobsToMarkdown(jobs));
  });

  it("dispatches to NDJSON", () => {
    const jobs = [job({ id: "d" }), job({ id: "e" })];
    expect(exportJobs(jobs, "ndjson")).toBe(jobsToNdjson(jobs));
  });

  it("dispatches to HTML", () => {
    const jobs = [job({ id: "d" })];
    expect(exportJobs(jobs, "html")).toBe(jobsToHtml(jobs));
  });

  it("exposes the supported formats", () => {
    expect(EXPORT_FORMATS).toEqual(["csv", "json", "md", "ndjson", "html"]);
  });
});
