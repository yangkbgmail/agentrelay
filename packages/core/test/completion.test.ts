import { describe, expect, it } from "vitest";
import { COMPLETION_SHELLS, type CompletionSpec, generateCompletion, isCompletionShell } from "../src/completion.js";

const SPEC: CompletionSpec = {
  program: "agentrelay",
  options: ["--store", "--config"],
  commands: [
    { name: "run", options: ["--tool"] },
    { name: "status", options: ["--watch", "--json", "--status", "--sort", "-r"] },
    {
      name: "config",
      options: [],
      subcommands: [
        { name: "init", options: ["--force", "-f"] },
        { name: "validate", options: [] },
        { name: "show", options: ["--json", "--show-secrets"] },
      ],
    },
  ],
};

describe("completion shell helpers", () => {
  it("COMPLETION_SHELLS lists bash, zsh and pwsh", () => {
    expect([...COMPLETION_SHELLS]).toEqual(["bash", "zsh", "pwsh"]);
  });

  it("isCompletionShell accepts known shells and rejects others", () => {
    expect(isCompletionShell("bash")).toBe(true);
    expect(isCompletionShell("zsh")).toBe(true);
    expect(isCompletionShell("pwsh")).toBe(true);
    expect(isCompletionShell("fish")).toBe(false);
    expect(isCompletionShell("powershell")).toBe(false);
    expect(isCompletionShell("")).toBe(false);
    expect(isCompletionShell("BASH")).toBe(false);
  });
});

describe("generateCompletion — bash", () => {
  const script = generateCompletion("bash", SPEC);

  it("registers the completion function for the program", () => {
    expect(script).toContain("complete -F _agentrelay_completion agentrelay");
    expect(script).toContain("_agentrelay_completion()");
  });

  it("offers the top-level command names", () => {
    expect(script).toContain('local commands="run status config"');
  });

  it("includes global options plus --help/--version at the top level", () => {
    expect(script).toContain('local global_opts="--store --config --help --version"');
  });

  it("dedupes --version when the spec already carries it (commander adds -V/--version)", () => {
    const withVersion = generateCompletion("bash", {
      program: "agentrelay",
      options: ["--version", "-V", "--store"],
      commands: [],
    });
    expect(withVersion).toContain('local global_opts="--version -V --store --help"');
  });

  it("adds a case arm per command with its flags and --help", () => {
    expect(script).toContain("run)");
    expect(script).toContain('compgen -W "--tool --help"');
    expect(script).toContain('compgen -W "--watch --json --status --sort -r --help"');
  });

  it("handles a parent command by completing its subcommands", () => {
    expect(script).toContain("config)");
    // subcommand list fallback
    expect(script).toContain('__opts="init validate show --help"');
    // per-subcommand flags
    expect(script).toContain('init) __opts="--force -f --help"');
    expect(script).toContain('show) __opts="--json --show-secrets --help"');
  });

  it("dedupes repeated flags while keeping first-seen order", () => {
    const dup = generateCompletion("bash", {
      program: "x",
      options: [],
      commands: [{ name: "c", options: ["--json", "--json", "-j"] }],
    });
    expect(dup).toContain('compgen -W "--json -j --help"');
  });
});

describe("generateCompletion — zsh", () => {
  const script = generateCompletion("zsh", SPEC);

  it("starts with the #compdef directive", () => {
    expect(script.startsWith("#compdef agentrelay")).toBe(true);
  });

  it("declares the command list and per-command arms", () => {
    expect(script).toContain("_agentrelay()");
    expect(script).toContain("'run'");
    expect(script).toContain("'status'");
    // parent command lists subcommands
    expect(script).toContain("'init'");
    expect(script).toContain("'validate'");
  });
});

describe("generateCompletion — pwsh", () => {
  const script = generateCompletion("pwsh", SPEC);

  it("registers a native argument completer for the program", () => {
    expect(script).toContain("Register-ArgumentCompleter -Native -CommandName agentrelay");
    expect(script).toContain("param($wordToComplete, $commandAst, $cursorPosition)");
  });

  it("declares the top-level command list and global options as PS arrays", () => {
    expect(script).toContain("$commands = @('run', 'status', 'config')");
    expect(script).toContain("$globalOptions = @('--store', '--config', '--help', '--version')");
  });

  it("dedupes --version when the spec already carries it", () => {
    const withVersion = generateCompletion("pwsh", {
      program: "agentrelay",
      options: ["--version", "-V", "--store"],
      commands: [],
    });
    expect(withVersion).toContain("$globalOptions = @('--version', '-V', '--store', '--help')");
  });

  it("adds a switch arm per command offering its flags plus --help", () => {
    expect(script).toContain("'run' { $suggestions = @('--tool', '--help') }");
    expect(script).toContain(
      "'status' { $suggestions = @('--watch', '--json', '--status', '--sort', '-r', '--help') }"
    );
  });

  it("offers a parent command's subcommand names (mirrors zsh)", () => {
    expect(script).toContain("'config' { $suggestions = @('init', 'validate', 'show', '--help') }");
  });

  it("filters suggestions by the word being completed", () => {
    expect(script).toContain('Where-Object { $_ -like "$wordToComplete*" }');
    expect(script).toContain("[System.Management.Automation.CompletionResult]::new(");
  });

  it("dedupes repeated flags while keeping first-seen order", () => {
    const dup = generateCompletion("pwsh", {
      program: "x",
      options: [],
      commands: [{ name: "c", options: ["--json", "--json", "-j"] }],
    });
    expect(dup).toContain("'c' { $suggestions = @('--json', '-j', '--help') }");
  });
});

describe("generateCompletion — safety", () => {
  it("throws on an unsafe command name rather than emitting it", () => {
    expect(() =>
      generateCompletion("bash", {
        program: "agentrelay",
        options: [],
        commands: [{ name: "run; rm -rf /", options: [] }],
      })
    ).toThrow(/unsafe command name/);
  });

  it("throws on an unsafe flag token", () => {
    expect(() =>
      generateCompletion("bash", {
        program: "agentrelay",
        options: [],
        commands: [{ name: "run", options: ["--x$(whoami)"] }],
      })
    ).toThrow(/unsafe/);
  });

  it("throws on an unsafe flag token for pwsh too (never emits a raw quote)", () => {
    expect(() =>
      generateCompletion("pwsh", {
        program: "agentrelay",
        options: [],
        commands: [{ name: "run", options: ["--x'; rm"] }],
      })
    ).toThrow(/unsafe/);
  });
});
