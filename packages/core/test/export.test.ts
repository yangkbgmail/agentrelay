import { describe, expect, it } from "vitest";
import {
  COLUMN_AWARE_FORMATS,
  EXPORT_FORMATS,
  escapeCsvField,
  escapeHtml,
  escapeHtmlCell,
  escapeMarkdownCell,
  exportJobs,
  isJobCsvColumn,
  JOB_CSV_COLUMNS,
  jobCsvValue,
  jobsToCsv,
  jobsToHtml,
  jobsToJson,
  jobsToMarkdown,
  jobsToNdjson,
  jobsToYaml,
  parseCsvColumns,
  yamlScalarString,
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

describe("isJobCsvColumn", () => {
  it("accepts every declared column and rejects unknown names", () => {
    for (const col of JOB_CSV_COLUMNS) {
      expect(isJobCsvColumn(col)).toBe(true);
    }
    expect(isJobCsvColumn("nope")).toBe(false);
    expect(isJobCsvColumn("")).toBe(false);
    expect(isJobCsvColumn("ID")).toBe(false); // case-sensitive
  });
});

describe("parseCsvColumns", () => {
  it("keeps valid columns in the order given", () => {
    expect(parseCsvColumns("status,id,project")).toEqual({
      columns: ["status", "id", "project"],
      invalid: [],
    });
  });

  it("trims whitespace and drops empty tokens (trailing/duplicate commas)", () => {
    expect(parseCsvColumns(" status , id ,,")).toEqual({
      columns: ["status", "id"],
      invalid: [],
    });
  });

  it("collects unrecognized names into invalid while keeping the valid ones", () => {
    expect(parseCsvColumns("id,bogus,status,nope")).toEqual({
      columns: ["id", "status"],
      invalid: ["bogus", "nope"],
    });
  });

  it("preserves intentional duplicates", () => {
    expect(parseCsvColumns("id,id").columns).toEqual(["id", "id"]);
  });

  it("returns no columns for an all-empty input", () => {
    expect(parseCsvColumns("").columns).toEqual([]);
    expect(parseCsvColumns("  , ,").columns).toEqual([]);
  });

  it("feeds jobsToCsv/jobsToMarkdown a validated subset end to end", () => {
    const { columns } = parseCsvColumns("status,id");
    expect(jobsToCsv([job({ id: "x", status: "queued" })], { columns })).toBe("status,id\nqueued,x");
    expect(jobsToMarkdown([job({ id: "x", status: "queued" })], { columns })).toContain("| status | id |");
  });
});

describe("COLUMN_AWARE_FORMATS", () => {
  it("lists exactly the tabular formats and is a subset of EXPORT_FORMATS", () => {
    expect([...COLUMN_AWARE_FORMATS]).toEqual(["csv", "md", "html"]);
    for (const f of COLUMN_AWARE_FORMATS) {
      expect(EXPORT_FORMATS).toContain(f);
    }
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

  it("passes the column subset through to HTML", () => {
    const jobs = [job({ id: "d", status: "queued" })];
    const columns = ["status", "id"] as const;
    expect(exportJobs(jobs, "html", { columns: [...columns] })).toBe(jobsToHtml(jobs, { columns: [...columns] }));
  });

  it("dispatches to YAML", () => {
    const jobs = [job({ id: "d" })];
    expect(exportJobs(jobs, "yaml")).toBe(jobsToYaml(jobs));
  });

  it("exposes the supported formats", () => {
    expect(EXPORT_FORMATS).toEqual(["csv", "json", "md", "ndjson", "html", "yaml"]);
  });
});

describe("escapeHtml", () => {
  it("leaves plain values untouched", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
    expect(escapeHtml("")).toBe("");
  });

  it("escapes the five HTML-special characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;"
    );
  });

  it("escapes ampersands first so entities are not double-escaped", () => {
    // A literal "&lt;" must become "&amp;lt;", not "&lt;".
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});

describe("escapeHtmlCell", () => {
  it("renders an empty value as an em dash", () => {
    expect(escapeHtmlCell("")).toBe("&mdash;");
  });

  it("turns newlines into <br> after escaping", () => {
    expect(escapeHtmlCell("a\nb")).toBe("a<br>b");
    expect(escapeHtmlCell("a\r\nb")).toBe("a<br>b");
  });

  it("escapes markup so a cell cannot break out", () => {
    expect(escapeHtmlCell("<b>hi</b>")).toBe("&lt;b&gt;hi&lt;/b&gt;");
  });
});

describe("jobsToHtml", () => {
  it("emits a standalone, self-contained document (doctype + inline style, no external requests)", () => {
    const out = jobsToHtml([job()]);
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(out).toContain("<style>");
    expect(out.trimEnd().endsWith("</html>")).toBe(true);
    // No external stylesheet/script references — the page renders offline.
    expect(out).not.toContain("<link");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("http://");
    expect(out).not.toContain("https://");
  });

  it("renders one <tr> per job plus a header row using the shared columns", () => {
    const out = jobsToHtml([job({ id: "a" }), job({ id: "b" })]);
    for (const col of JOB_CSV_COLUMNS) {
      expect(out).toContain(`<th>${col}</th>`);
    }
    // Two data rows in the body.
    expect(out.match(/<tbody>[\s\S]*<\/tbody>/)?.[0].match(/<tr>/g)).toHaveLength(2);
  });

  it("colour-codes the status cell with a per-state class", () => {
    const out = jobsToHtml([job({ status: "failed" })]);
    expect(out).toContain(`<td class="status status-failed">failed</td>`);
  });

  it("escapes markup in cell values so a command cannot inject HTML", () => {
    const out = jobsToHtml([job({ command: ["echo", "<script>"] })]);
    expect(out).toContain("echo &lt;script&gt;");
    expect(out).not.toContain("<script>");
  });

  it("shows a placeholder row (not a blank table) for an empty job list", () => {
    const out = jobsToHtml([]);
    expect(out).toContain("(no jobs)");
    expect(out).toContain(`colspan="${JOB_CSV_COLUMNS.length}"`);
  });

  it("uses the given title in both <title> and the heading, escaping it", () => {
    const out = jobsToHtml([], { title: "A & B <report>" });
    expect(out).toContain("<title>A &amp; B &lt;report&gt;</title>");
    expect(out).toContain("<h1>A &amp; B &lt;report&gt;</h1>");
  });

  it("honors a column subset and order (composing with --columns)", () => {
    const out = jobsToHtml([job({ id: "x", status: "queued" })], { columns: ["status", "id"] });
    expect(out).toContain("<th>status</th><th>id</th>");
    expect(out).not.toContain("<th>project</th>");
  });
});

describe("yamlScalarString", () => {
  it("leaves an unambiguous plain scalar unquoted", () => {
    expect(yamlScalarString("claude-code")).toBe("claude-code");
    expect(yamlScalarString("proj_1")).toBe("proj_1");
    expect(yamlScalarString("job-42")).toBe("job-42");
  });

  it("quotes the empty string (a bare blank would parse as null)", () => {
    expect(yamlScalarString("")).toBe('""');
  });

  it("quotes strings that would reparse as a non-string type", () => {
    // Numeric- and boolean/null-looking values must be quoted to stay strings.
    expect(yamlScalarString("42")).toBe('"42"');
    expect(yamlScalarString("3.14")).toBe('"3.14"');
    expect(yamlScalarString("true")).toBe('"true"');
    expect(yamlScalarString("No")).toBe('"No"');
    expect(yamlScalarString("null")).toBe('"null"');
    expect(yamlScalarString("~")).toBe('"~"');
  });

  it("quotes leading indicators and colon-bearing values (ISO timestamps)", () => {
    expect(yamlScalarString("-p")).toBe('"-p"');
    expect(yamlScalarString("2026-07-13T00:00:00.000Z")).toBe('"2026-07-13T00:00:00.000Z"');
    expect(yamlScalarString("a: b")).toBe('"a: b"');
    expect(yamlScalarString("#comment")).toBe('"#comment"');
  });

  it("escapes backslashes, quotes, and whitespace controls in the quoted form", () => {
    expect(yamlScalarString('a"b')).toBe('"a\\"b"');
    expect(yamlScalarString("a\\b")).toBe('"a\\\\b"');
    expect(yamlScalarString("line1\nline2")).toBe('"line1\\nline2"');
    expect(yamlScalarString("a\tb")).toBe('"a\\tb"');
  });
});

describe("jobsToYaml", () => {
  it("renders an empty list as an empty YAML sequence", () => {
    expect(jobsToYaml([])).toBe("[]");
  });

  it("emits a block sequence of mappings with the first key on the dash line", () => {
    const out = jobsToYaml([job({ id: "a", project: "proj", attempts: 2 })]);
    const lines = out.split("\n");
    expect(lines[0]).toBe("- id: a");
    // Sibling keys align two spaces in, under the hoisted first key.
    expect(lines).toContain("  project: proj");
    // Numbers are emitted unquoted.
    expect(lines).toContain("  attempts: 2");
  });

  it("renders the command array as an indented block sequence, quoting when needed", () => {
    const out = jobsToYaml([job({ command: ["claude", "-p", "a b"] })]);
    expect(out).toContain('  command:\n    - claude\n    - "-p"\n    - "a b"');
  });

  it("emits an empty command array inline", () => {
    const out = jobsToYaml([job({ command: [] })]);
    expect(out).toContain("  command: []");
  });

  it("renders null fields as null and nests lastRateLimit as a mapping", () => {
    const out = jobsToYaml([
      job({
        resetAt: null,
        lastError: null,
        lastRateLimit: {
          pattern: "clock-time",
          rawMatch: "resets at 5pm",
          resetAt: "2026-07-13T17:00:00.000Z",
          detectedAt: "2026-07-13T12:00:00.000Z",
        },
      }),
    ]);
    expect(out).toContain("  resetAt: null");
    expect(out).toContain("  lastError: null");
    expect(out).toContain("  lastRateLimit:\n    pattern: clock-time");
    expect(out).toContain('    rawMatch: "resets at 5pm"');
    expect(out).toContain('    resetAt: "2026-07-13T17:00:00.000Z"');
  });

  it("omits an undefined lastRateLimit (mirrors JSON dropping undefined keys)", () => {
    const out = jobsToYaml([job()]);
    expect(out).not.toContain("lastRateLimit");
  });

  it("separates multiple jobs as top-level sequence entries", () => {
    const out = jobsToYaml([job({ id: "a" }), job({ id: "b" })]);
    const dashLines = out.split("\n").filter((l) => l.startsWith("- id:"));
    expect(dashLines).toEqual(["- id: a", "- id: b"]);
  });

  it("has no trailing newline (the file writer adds it)", () => {
    expect(jobsToYaml([job()]).endsWith("\n")).toBe(false);
  });
});
