import { describe, expect, it } from "vitest";
import { escapeTroff, generateManPage, type ManPageSpec } from "./manpage.js";

function baseSpec(overrides: Partial<ManPageSpec> = {}): ManPageSpec {
  return {
    program: "agentrelay",
    section: 1,
    version: "0.1.0",
    description: "Wrap AI coding agent CLI calls and auto-resume once the limit resets.",
    date: "2026-07-26",
    options: [{ flags: "--store <path>", description: "Path to the job store JSON file" }],
    commands: [
      {
        name: "run",
        args: "<command...>",
        description: "Run a command, watching its output for rate-limit messages",
        options: [{ flags: "--tool <tool>", description: "Agent tool adapter to use" }],
        subcommands: [],
      },
    ],
    ...overrides,
  };
}

describe("escapeTroff", () => {
  it("doubles backslashes and escapes hyphens", () => {
    expect(escapeTroff("a-b\\c")).toBe("a\\-b\\ec");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeTroff("Run a command now")).toBe("Run a command now");
  });

  it("escapes every hyphen in a flag string", () => {
    expect(escapeTroff("-s, --status")).toBe("\\-s, \\-\\-status");
  });
});

describe("generateManPage", () => {
  it("emits a .TH header with title, section, date and version", () => {
    const out = generateManPage(baseSpec());
    expect(out).toContain('.TH AGENTRELAY 1 "2026\\-07\\-26" "agentrelay 0.1.0" "User Commands"');
  });

  it("honors a custom manual name", () => {
    const out = generateManPage(baseSpec({ manual: "Relay Manual" }));
    expect(out).toContain('"Relay Manual"');
  });

  it("includes the standard man sections in order", () => {
    const out = generateManPage(baseSpec());
    const idxName = out.indexOf(".SH NAME");
    const idxSyn = out.indexOf(".SH SYNOPSIS");
    const idxDesc = out.indexOf(".SH DESCRIPTION");
    const idxOpts = out.indexOf(".SH GLOBAL OPTIONS");
    const idxCmds = out.indexOf(".SH COMMANDS");
    expect(idxName).toBeGreaterThanOrEqual(0);
    expect(idxSyn).toBeGreaterThan(idxName);
    expect(idxDesc).toBeGreaterThan(idxSyn);
    expect(idxOpts).toBeGreaterThan(idxDesc);
    expect(idxCmds).toBeGreaterThan(idxOpts);
  });

  it("renders the NAME line as program \\- description", () => {
    const out = generateManPage(baseSpec());
    expect(out).toContain("agentrelay \\- Wrap AI coding agent CLI calls and auto\\-resume once the limit resets.");
  });

  it("renders each global option as a bold .TP entry", () => {
    const out = generateManPage(baseSpec());
    expect(out).toContain(".TP\n.B \\-\\-store <path>\nPath to the job store JSON file");
  });

  it("renders a command as a .SS subsection with bold synopsis and description", () => {
    const out = generateManPage(baseSpec());
    expect(out).toContain(".SS run");
    expect(out).toContain(".B agentrelay run <command...>");
    expect(out).toContain("Run a command, watching its output for rate\\-limit messages");
  });

  it("renders command-level options under the command", () => {
    const out = generateManPage(baseSpec());
    const ssIdx = out.indexOf(".SS run");
    const optIdx = out.indexOf(".B \\-\\-tool <tool>");
    expect(optIdx).toBeGreaterThan(ssIdx);
  });

  it("indents subcommands with .RS/.RE under the parent subsection", () => {
    const out = generateManPage(
      baseSpec({
        commands: [
          {
            name: "config",
            args: "",
            description: "Manage the config file",
            options: [],
            subcommands: [
              {
                name: "init",
                args: "[path]",
                description: "Write a sample config file",
                options: [{ flags: "-f, --force", description: "Overwrite an existing file" }],
                subcommands: [],
              },
            ],
          },
        ],
      })
    );
    expect(out).toContain(".SS config");
    expect(out).toContain(".B agentrelay config init [path]");
    expect(out).toContain(".RS 4");
    expect(out).toContain(".RE");
    // The subcommand's own option is present inside the block.
    expect(out).toContain(".B \\-f, \\-\\-force");
  });

  it("renders a FILES section only when files are supplied", () => {
    const withoutFiles = generateManPage(baseSpec());
    expect(withoutFiles).not.toContain(".SH FILES");

    const withFiles = generateManPage(
      baseSpec({ files: [{ path: "~/.agentrelay/jobs.json", description: "The job store" }] })
    );
    expect(withFiles).toContain(".SH FILES");
    expect(withFiles).toContain(".I ~/.agentrelay/jobs.json");
    expect(withFiles).toContain("The job store");
  });

  it("omits GLOBAL OPTIONS and COMMANDS sections when empty", () => {
    const out = generateManPage(baseSpec({ options: [], commands: [] }));
    expect(out).not.toContain(".SH GLOBAL OPTIONS");
    expect(out).not.toContain(".SH COMMANDS");
  });

  it("guards a description that starts with a control character", () => {
    const out = generateManPage(baseSpec({ description: ".dangerous leading dot" }));
    // The NAME/DESCRIPTION body line must be prefixed with \& so troff treats it as text.
    expect(out).toContain("\\&.dangerous leading dot");
  });

  it("supplies a placeholder line for an option with no description", () => {
    const out = generateManPage(baseSpec({ options: [{ flags: "--flag", description: "" }] }));
    expect(out).toContain(".TP\n.B \\-\\-flag\n\\ ");
  });

  it("ends with a trailing newline", () => {
    const out = generateManPage(baseSpec());
    expect(out.endsWith("\n")).toBe(true);
  });
});
