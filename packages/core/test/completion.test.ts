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
  it("COMPLETION_SHELLS lists bash, zsh, and powershell", () => {
    expect([...COMPLETION_SHELLS]).toEqual(["bash", "zsh", "powershell"]);
  });

  it("isCompletionShell accepts known shells and rejects others", () => {
    expect(isCompletionShell("bash")).toBe(true);
    expect(isCompletionShell("zsh")).toBe(true);
    expect(isCompletionShell("powershell")).toBe(true);
    expect(isCompletionShell("fish")).toBe(false);
    expect(isCompletionShell("")).toBe(false);
    expect(isCompletionShell("BASH")).toBe(false);
    expect(isCompletionShell("PowerShell")).toBe(false);
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

describe("generateCompletion — powershell", () => {
  const script = generateCompletion("powershell", SPEC);

  it("registers a native argument completer for the program", () => {
    expect(script).toContain("Register-ArgumentCompleter -Native -CommandName agentrelay");
    expect(script).toContain("param($wordToComplete, $commandAst, $cursorPosition)");
  });

  it("declares the top-level command list", () => {
    expect(script).toContain("$commands = @('run', 'status', 'config')");
  });

  it("includes global options plus --help/--version", () => {
    expect(script).toContain("$globalOptions = @('--store', '--config', '--help', '--version')");
  });

  it("maps each leaf command to its flags plus --help", () => {
    expect(script).toContain("'run' = @('--tool', '--help')");
    expect(script).toContain("'status' = @('--watch', '--json', '--status', '--sort', '-r', '--help')");
  });

  it("maps a parent command to its subcommand names plus --help", () => {
    expect(script).toContain("'config' = @('init', 'validate', 'show', '--help')");
  });

  it("maps each 'parent sub' key to that subcommand's flags", () => {
    expect(script).toContain("'config init' = @('--force', '-f', '--help')");
    expect(script).toContain("'config show' = @('--json', '--show-secrets', '--help')");
  });

  it("prefix-filters suggestions and emits CompletionResult objects", () => {
    expect(script).toContain('Where-Object { $_ -like "$wordToComplete*" }');
    expect(script).toContain("[System.Management.Automation.CompletionResult]::new(");
  });

  it("dedupes repeated flags while keeping first-seen order", () => {
    const dup = generateCompletion("powershell", {
      program: "x",
      options: [],
      commands: [{ name: "c", options: ["--json", "--json", "-j"] }],
    });
    expect(dup).toContain("'c' = @('--json', '-j', '--help')");
  });

  it("uses empty hashtables when there are no leaf commands or subcommands", () => {
    const bare = generateCompletion("powershell", {
      program: "agentrelay",
      options: [],
      commands: [],
    });
    expect(bare).toContain("$commands = @()");
    expect(bare).toContain("$commandOptions = @{}");
    expect(bare).toContain("$subcommands = @{}");
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
});
