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
  it("COMPLETION_SHELLS lists bash, zsh, fish and pwsh", () => {
    expect([...COMPLETION_SHELLS]).toEqual(["bash", "zsh", "fish", "pwsh"]);
  });

  it("isCompletionShell accepts known shells and rejects others", () => {
    expect(isCompletionShell("bash")).toBe(true);
    expect(isCompletionShell("zsh")).toBe(true);
    expect(isCompletionShell("fish")).toBe(true);
    expect(isCompletionShell("pwsh")).toBe(true);
    expect(isCompletionShell("tcsh")).toBe(false);
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

describe("generateCompletion — fish", () => {
  const script = generateCompletion("fish", SPEC);

  it("starts with the fish header and disables file completion", () => {
    expect(script.startsWith("# fish completion for agentrelay")).toBe(true);
    expect(script).toContain("complete -c agentrelay -f");
  });

  it("offers global options and top-level subcommands under __fish_use_subcommand", () => {
    expect(script).toContain("complete -c agentrelay -n __fish_use_subcommand -l store");
    expect(script).toContain("complete -c agentrelay -n __fish_use_subcommand -l config");
    expect(script).toContain("complete -c agentrelay -n __fish_use_subcommand -l help");
    expect(script).toContain("complete -c agentrelay -n __fish_use_subcommand -l version");
    expect(script).toContain("complete -c agentrelay -n __fish_use_subcommand -a run");
    expect(script).toContain("complete -c agentrelay -n __fish_use_subcommand -a status");
    expect(script).toContain("complete -c agentrelay -n __fish_use_subcommand -a config");
  });

  it("maps long/short flags to -l/-s tokens scoped to their command", () => {
    expect(script).toContain("complete -c agentrelay -n '__fish_seen_subcommand_from run' -l tool");
    expect(script).toContain("complete -c agentrelay -n '__fish_seen_subcommand_from status' -l json");
    expect(script).toContain("complete -c agentrelay -n '__fish_seen_subcommand_from status' -s r");
  });

  it("offers a parent command's subcommands only until one is chosen", () => {
    expect(script).toContain(
      "complete -c agentrelay -n '__fish_seen_subcommand_from config; and not __fish_seen_subcommand_from init validate show' -a init"
    );
    // each subcommand's own flags key off that subcommand being seen
    expect(script).toContain("complete -c agentrelay -n '__fish_seen_subcommand_from init' -l force");
    expect(script).toContain("complete -c agentrelay -n '__fish_seen_subcommand_from init' -s f");
    expect(script).toContain("complete -c agentrelay -n '__fish_seen_subcommand_from show' -l show-secrets");
  });

  it("dedupes repeated flags while keeping first-seen order", () => {
    const dup = generateCompletion("fish", {
      program: "x",
      options: [],
      commands: [{ name: "c", options: ["--json", "--json", "-j"] }],
    });
    const jsonLines = dup.split("\n").filter((l) => l.includes("-l json"));
    expect(jsonLines).toHaveLength(1);
    expect(dup).toContain("complete -c x -n '__fish_seen_subcommand_from c' -s j");
  });

  it("throws on an unsafe token rather than emitting it", () => {
    expect(() =>
      generateCompletion("fish", {
        program: "agentrelay",
        options: [],
        commands: [{ name: "run; rm -rf /", options: [] }],
      })
    ).toThrow(/unsafe command name/);
  });
});

describe("generateCompletion — pwsh", () => {
  const script = generateCompletion("pwsh", SPEC);

  it("starts with the PowerShell header and registers a native completer", () => {
    expect(script.startsWith("# PowerShell completion for agentrelay")).toBe(true);
    expect(script).toContain("Register-ArgumentCompleter -Native -CommandName agentrelay");
  });

  it("bakes in the top-level commands and global options as arrays", () => {
    expect(script).toContain("$commands = @('run', 'status', 'config')");
    expect(script).toContain("$globalOpts = @('--store', '--config', '--help', '--version')");
  });

  it("maps leaf commands to their flags in the commandOpts hashtable", () => {
    expect(script).toContain("'run' = @('--tool', '--help')");
    expect(script).toContain("'status' = @('--watch', '--json', '--status', '--sort', '-r', '--help')");
  });

  it("records a parent command's subcommands and each subcommand's flags", () => {
    expect(script).toContain("'config' = @('init', 'validate', 'show')");
    expect(script).toContain("'config init' = @('--force', '-f', '--help')");
    expect(script).toContain("'config show' = @('--json', '--show-secrets', '--help')");
  });

  it("dedupes repeated flags while keeping first-seen order", () => {
    const dup = generateCompletion("pwsh", {
      program: "x",
      options: [],
      commands: [{ name: "c", options: ["--json", "--json", "-j"] }],
    });
    expect(dup).toContain("'c' = @('--json', '-j', '--help')");
  });

  it("emits an empty hashtable when a table has no entries", () => {
    const noParents = generateCompletion("pwsh", {
      program: "x",
      options: [],
      commands: [{ name: "c", options: ["--json"] }],
    });
    // No parent commands -> $subcommands / $subOpts are empty hashtables.
    expect(noParents).toContain("$subcommands = @{}");
    expect(noParents).toContain("$subOpts = @{}");
  });

  it("throws on an unsafe command name rather than emitting it", () => {
    expect(() =>
      generateCompletion("pwsh", {
        program: "agentrelay",
        options: [],
        commands: [{ name: "run; rm -rf /", options: [] }],
      })
    ).toThrow(/unsafe command name/);
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
