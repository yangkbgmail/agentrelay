import { describe, expect, it } from "vitest";
import {
  countByStatus,
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

  it("escapes the five markup-breaking characters", () => {
    expect(escapeHtml(`<a href="x" class='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; class=&#39;y&#39;&gt;&amp;&lt;/a&gt;"
    );
  });

  it("escapes ampersands first so entities aren't double-escaped", () => {
    // A literal "<" must become "&lt;", not "&amp;lt;".
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("passes newlines through (rendered via white-space: pre-wrap)", () => {
    expect(escapeHtml("line1\nline2")).toBe("line1\nline2");
  });
});

describe("countByStatus", () => {
  it("counts jobs per status, preserving first-encounter order", () => {
    const counts = countByStatus([
      job({ status: "completed" }),
      job({ status: "failed" }),
      job({ status: "completed" }),
    ]);
    expect(counts).toEqual([
      { status: "completed", count: 2 },
      { status: "failed", count: 1 },
    ]);
  });

  it("returns an empty array for an empty store", () => {
    expect(countByStatus([])).toEqual([]);
  });
});

describe("jobsToHtml", () => {
  it("emits a self-contained document with inlined styles", () => {
    const html = jobsToHtml([job()]);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<style>");
    expect(html).toContain("prefers-color-scheme: dark");
    // No external assets: nothing to fetch, so the file works offline.
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
  });

  it("renders a table header from the columns and one row per job", () => {
    const html = jobsToHtml([job({ id: "j1", project: "p1" }), job({ id: "j2", status: "failed" })]);
    for (const col of JOB_CSV_COLUMNS) {
      expect(html).toContain(`<th>${col}</th>`);
    }
    expect(html).toContain(">j1<");
    expect(html).toContain(">j2<");
    // Two data rows.
    expect(html.match(/<tr>/g)?.length).toBe(3); // 1 head + 2 body
  });

  it("wraps the status cell in a status class for color coding", () => {
    const html = jobsToHtml([job({ status: "failed" })]);
    expect(html).toContain('<span class="status status-failed">failed</span>');
  });

  it("renders per-status summary chips with counts", () => {
    const html = jobsToHtml([job({ status: "completed" }), job({ status: "completed" }), job({ status: "failed" })]);
    expect(html).toContain('<span class="chip chip-completed">completed<b>2</b></span>');
    expect(html).toContain('<span class="chip chip-failed">failed<b>1</b></span>');
  });

  it("HTML-escapes cell values so markup in prompts/errors can't break out", () => {
    const html = jobsToHtml([job({ command: ["claude", "-p", "<b>hi</b> & 'go'"], lastError: 'boom "x"' })]);
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt; &amp; &#39;go&#39;");
    expect(html).toContain("boom &quot;x&quot;");
    // The raw, unescaped forms must not appear as live markup.
    expect(html).not.toContain("<b>hi</b>");
  });

  it("renders null resetAt/lastError as a muted em dash", () => {
    const html = jobsToHtml([job({ resetAt: null, lastError: null })]);
    expect(html).toContain('<span class="empty">—</span>');
  });

  it("shows an empty-state row (spanning all columns) for an empty store", () => {
    const html = jobsToHtml([]);
    expect(html).toContain(`colspan="${JOB_CSV_COLUMNS.length}"`);
    expect(html).toContain("No jobs to display.");
    expect(html).toContain('<p class="meta">0 jobs</p>');
  });

  it("uses a singular label for exactly one job and honors a custom title", () => {
    const html = jobsToHtml([job()], { title: "My <Report>" });
    expect(html).toContain('<p class="meta">1 job</p>');
    // Title is escaped in both the <title> and <h1>.
    expect(html).toContain("<title>My &lt;Report&gt;</title>");
    expect(html).toContain("<h1>My &lt;Report&gt;</h1>");
  });

  it("honors a custom column subset and order", () => {
    const html = jobsToHtml([job({ id: "x", status: "queued" })], { columns: ["status", "id"] });
    const headOrder = html.indexOf("<th>status</th>");
    const idHead = html.indexOf("<th>id</th>");
    expect(headOrder).toBeGreaterThan(-1);
    expect(idHead).toBeGreaterThan(headOrder);
    expect(html).not.toContain("<th>project</th>");
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
