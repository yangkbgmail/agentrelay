import { describe, expect, it } from "vitest";
import { generateManPage, type ManPageSpec } from "../src/manpage.js";

const SPEC: ManPageSpec = {
  program: "agentrelay",
  version: "0.1.0",
  date: "2026-08-22",
  description: "auto-resume rate-limited AI coding agents",
  longDescription: "Detect an agent's rate-limit message and re-run it once the limit resets.",
  options: [
    { flags: "--store <path>", description: "Path to the job store" },
    { flags: "-c, --config <path>", description: "Path to agentrelay.config.json" },
  ],
  commands: [
    {
      name: "run",
      args: "-- <command...>",
      description: "Run a command and watch for rate limits",
      options: [{ flags: "--tool <tool>", description: "Force the agent tool" }],
    },
    {
      name: "status",
      description: "List all jobs",
      options: [{ flags: "--json", description: "Emit machine-readable JSON" }],
    },
    {
      name: "config",
      description: "Manage the config file",
      options: [],
      subcommands: [
        {
          name: "init",
          args: "[path]",
          description: "Write a sample config",
          options: [{ flags: "-f, --force", description: "Overwrite an existing file" }],
        },
        { name: "show", description: "Show effective config", options: [] },
      ],
    },
  ],
  files: [{ path: "~/.agentrelay/jobs.json", description: "The job store" }],
  seeAlso: ["agentrelay-completion(1)"],
};

describe("generateManPage", () => {
  const page = generateManPage(SPEC);

  it("emits a section-1 .TH header with title, version and date", () => {
    expect(page.startsWith('.TH "AGENTRELAY" "1" "2026-08-22" "agentrelay 0.1.0" "User Commands"\n')).toBe(true);
  });

  it("renders the NAME section with an escaped dash", () => {
    expect(page).toContain(".SH NAME");
    expect(page).toContain("agentrelay \\- auto\\-resume rate\\-limited AI coding agents");
  });

  it("renders a SYNOPSIS with the program in bold", () => {
    expect(page).toContain(".SH SYNOPSIS");
    expect(page).toContain(".B agentrelay");
    expect(page).toContain("[\\fIOPTIONS\\fR] \\fICOMMAND\\fR [\\fIARGS\\fR]");
  });

  it("prefers longDescription for the DESCRIPTION body", () => {
    expect(page).toContain(".SH DESCRIPTION");
    expect(page).toContain("Detect an agent's rate\\-limit message");
  });

  it("lists global options as bold .TP paragraphs", () => {
    expect(page).toContain(".SH GLOBAL OPTIONS");
    expect(page).toContain(".TP\n\\fB\\-\\-store <path>\\fR\nPath to the job store");
  });

  it("renders each top-level command as an .SS subsection with its args", () => {
    expect(page).toContain(".SH COMMANDS");
    expect(page).toContain(".SS run \\-\\- <command...>");
    expect(page).toContain(".SS status");
  });

  it("renders each command's options under it", () => {
    expect(page).toContain("\\fB\\-\\-tool <tool>\\fR\nForce the agent tool");
    expect(page).toContain("\\fB\\-\\-json\\fR\nEmit machine\\-readable JSON");
  });

  it("nests subcommands with the full command path", () => {
    expect(page).toContain(".SS config init [path]");
    expect(page).toContain(".SS config show");
    expect(page).toContain("\\fB\\-f, \\-\\-force\\fR\nOverwrite an existing file");
  });

  it("renders a FILES section", () => {
    expect(page).toContain(".SH FILES");
    expect(page).toContain("\\fI~/.agentrelay/jobs.json\\fR\nThe job store");
  });

  it("renders SEE ALSO", () => {
    expect(page).toContain(".SH SEE ALSO");
    expect(page).toContain("agentrelay\\-completion(1)");
  });

  it("ends with a trailing newline", () => {
    expect(page.endsWith("\n")).toBe(true);
  });
});

describe("generateManPage — roff safety", () => {
  it("escapes a backslash in text to \\e", () => {
    const page = generateManPage({
      program: "ar",
      description: "a back\\slash here",
      options: [],
      commands: [],
    });
    expect(page).toContain("a back\\eslash here");
  });

  it("guards a description that starts with a control character", () => {
    const page = generateManPage({
      program: "ar",
      description: ".dotfile leader",
      options: [],
      commands: [{ name: "x", description: "'quote leader", options: [] }],
    });
    // NAME body and command body both get a \& guard.
    expect(page).toContain("ar \\- \\&.dotfile leader");
    expect(page).toContain("\\&'quote leader");
  });

  it("defaults section, manual, and empty date", () => {
    const page = generateManPage({ program: "ar", description: "d", options: [], commands: [] });
    expect(page.startsWith('.TH "AR" "1" "" "ar" "User Commands"\n')).toBe(true);
  });

  it("substitutes a placeholder body for an empty option description", () => {
    const page = generateManPage({
      program: "ar",
      description: "d",
      options: [{ flags: "--x", description: "" }],
      commands: [],
    });
    expect(page).toContain(".TP\n\\fB\\-\\-x\\fR\n\\ ");
  });

  it("throws on an empty program name", () => {
    expect(() => generateManPage({ program: "  ", description: "d", options: [], commands: [] })).toThrow(
      /empty program name/
    );
  });

  it("omits optional sections when their inputs are empty", () => {
    const page = generateManPage({ program: "ar", description: "d", options: [], commands: [] });
    expect(page).not.toContain(".SH GLOBAL OPTIONS");
    expect(page).not.toContain(".SH COMMANDS");
    expect(page).not.toContain(".SH FILES");
    expect(page).not.toContain(".SH SEE ALSO");
  });
});
