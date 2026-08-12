import { describe, expect, it } from "vitest";
import { escapeRoff, generateManPage, type ManSpec } from "../src/man.js";

const SPEC: ManSpec = {
  program: "agentrelay",
  version: "0.1.0",
  summary: "Wrap AI agent CLI calls, detect rate-limit messages, and auto-resume once the limit resets.",
  options: [
    { flags: "--store <path>", description: "Path to the job store JSON file" },
    { flags: "--config <path>", description: "Path to an agentrelay.config.json" },
  ],
  commands: [
    {
      name: "run",
      usage: "[options] <command...>",
      description: "Run a command, watching its output for rate-limit messages",
      options: [{ flags: "--tool <tool>", description: "Agent tool adapter to use" }],
    },
    {
      name: "status",
      usage: "[options]",
      description: "List all jobs and their current state",
      options: [{ flags: "-w, --watch [seconds]", description: "Live-refresh the table" }, { flags: "--json" }],
    },
    {
      name: "config",
      usage: "[options]",
      description: "Manage the config file",
      options: [],
      subcommands: [
        { name: "init", usage: "[path]", description: "Write a sample config", options: [{ flags: "-f, --force" }] },
        { name: "show", description: "Show effective config", options: [{ flags: "--json" }] },
      ],
    },
  ],
};

describe("escapeRoff", () => {
  it("escapes hyphens to \\- so flags render as a minus", () => {
    expect(escapeRoff("--json")).toBe("\\-\\-json");
  });

  it("escapes a literal backslash to \\e before hyphens (no double-escape)", () => {
    expect(escapeRoff("a\\b-c")).toBe("a\\eb\\-c");
  });

  it("leaves plain text untouched", () => {
    expect(escapeRoff("hello world")).toBe("hello world");
  });
});

describe("generateManPage — header", () => {
  const page = generateManPage(SPEC, { date: "2026-08-12" });

  it("emits a .TH header with uppercased title, section 1, date, and source", () => {
    expect(page.startsWith('.TH AGENTRELAY 1 "2026-08-12" "agentrelay 0.1.0" "User Commands"')).toBe(true);
  });

  it("honors a custom section number", () => {
    const p = generateManPage(SPEC, { date: "2026-08-12", section: 8 });
    expect(p.startsWith(".TH AGENTRELAY 8 ")).toBe(true);
  });

  it("falls back to the program name as source when no version is set", () => {
    const p = generateManPage({ ...SPEC, version: undefined }, { date: "2026-08-12" });
    expect(p).toContain('"agentrelay" "User Commands"');
  });

  it("ends with a trailing newline", () => {
    expect(page.endsWith("\n")).toBe(true);
  });
});

describe("generateManPage — sections", () => {
  const page = generateManPage(SPEC, { date: "2026-08-12" });

  it("renders NAME with an escaped summary", () => {
    expect(page).toContain(".SH NAME");
    expect(page).toContain("agentrelay \\- Wrap AI agent CLI calls");
  });

  it("renders a SYNOPSIS line", () => {
    expect(page).toContain(".SH SYNOPSIS");
    expect(page).toContain(".B agentrelay");
    expect(page).toContain("[\\fIglobal options\\fR] \\fIcommand\\fR [\\fIargs\\fR...]");
  });

  it("renders DESCRIPTION from the summary", () => {
    expect(page).toContain(".SH DESCRIPTION");
  });

  it("renders GLOBAL OPTIONS as .TP rows with bold, escaped flags", () => {
    expect(page).toContain(".SH GLOBAL OPTIONS");
    expect(page).toContain(".B \\-\\-store <path>");
    expect(page).toContain("Path to the job store JSON file");
  });

  it("renders COMMANDS with an .SS heading per command including usage", () => {
    expect(page).toContain(".SH COMMANDS");
    expect(page).toContain(".SS run [options] <command...>");
    expect(page).toContain("Run a command, watching its output for rate\\-limit messages");
  });

  it("renders per-command options and a placeholder when a flag has no description", () => {
    expect(page).toContain(".B \\-w, \\-\\-watch [seconds]");
    // status --json has no description
    expect(page).toContain("(no description)");
  });

  it("renders subcommands as nested .SS headings prefixed by the parent", () => {
    expect(page).toContain(".SS config init [path]");
    expect(page).toContain(".SS config show");
    expect(page).toContain(".B \\-f, \\-\\-force");
  });
});

describe("generateManPage — robustness", () => {
  it("omits GLOBAL OPTIONS and COMMANDS sections when empty", () => {
    const p = generateManPage({ program: "x", summary: "y", options: [], commands: [] }, { date: "d" });
    expect(p).not.toContain(".SH GLOBAL OPTIONS");
    expect(p).not.toContain(".SH COMMANDS");
    expect(p).toContain(".SH NAME");
  });

  it("guards a description that starts with a dot so it is not read as a request", () => {
    const p = generateManPage(
      {
        program: "x",
        options: [],
        commands: [{ name: "c", options: [{ flags: "--f", description: ".bashrc is sourced first" }] }],
      },
      { date: "d" }
    );
    // leading '.' would be escaped to '\-'? no — '.' is not hyphen; the \& guard applies
    expect(p).toContain("\\&.bashrc is sourced first");
  });

  it("strips quotes/newlines from .TH fields to keep the header well-formed", () => {
    const p = generateManPage({ program: "x", options: [], commands: [] }, { date: 'a"b\nc', source: 'q"r' });
    expect(p).toContain('.TH X 1 "a b c" "q r" "User Commands"');
  });
});
