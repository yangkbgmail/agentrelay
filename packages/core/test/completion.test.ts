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
  it("COMPLETION_SHELLS lists bash, zsh, and fish", () => {
    expect([...COMPLETION_SHELLS]).toEqual(["bash", "zsh", "fish"]);
  });

  it("isCompletionShell accepts known shells and rejects others", () => {
    expect(isCompletionShell("bash")).toBe(true);
    expect(isCompletionShell("zsh")).toBe(true);
    expect(isCompletionShell("fish")).toBe(true);
    expect(isCompletionShell("")).toBe(false);
    expect(isCompletionShell("BASH")).toBe(false);
    expect(isCompletionShell("pwsh")).toBe(false);
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

  it("starts with the fish install header and defines the arg helper", () => {
    expect(script.startsWith("# fish completion for agentrelay")).toBe(true);
    expect(script).toContain("function __fish_agentrelay_args");
    expect(script).toContain("function __fish_agentrelay_no_subcommand");
    expect(script).toContain("function __fish_agentrelay_using_command");
    expect(script).toContain("function __fish_agentrelay_using_subcommand");
  });

  it("offers the top-level command names before any subcommand", () => {
    expect(script).toContain("complete -c agentrelay -f -n '__fish_agentrelay_no_subcommand' -a 'run status config'");
  });

  it("offers global options plus --help/--version at the top level", () => {
    expect(script).toContain("complete -c agentrelay -n '__fish_agentrelay_no_subcommand' -l store");
    expect(script).toContain("complete -c agentrelay -n '__fish_agentrelay_no_subcommand' -l help");
    expect(script).toContain("complete -c agentrelay -n '__fish_agentrelay_no_subcommand' -l version");
  });

  it("maps long, short, and old-style option tokens", () => {
    // long flag → -l, short flag → -s
    expect(script).toContain("complete -c agentrelay -n '__fish_agentrelay_using_command status' -l json");
    expect(script).toContain("complete -c agentrelay -n '__fish_agentrelay_using_command status' -s r");
  });

  it("offers subcommand names only while the subcommand slot is bare", () => {
    expect(script).toContain(
      "complete -c agentrelay -f -n '__fish_agentrelay_command_bare config' -a 'init validate show'"
    );
    // per-subcommand flags gate on using_subcommand
    expect(script).toContain("complete -c agentrelay -n '__fish_agentrelay_using_subcommand config init' -l force");
    expect(script).toContain("complete -c agentrelay -n '__fish_agentrelay_using_subcommand config init' -s f");
    expect(script).toContain(
      "complete -c agentrelay -n '__fish_agentrelay_using_subcommand config show' -l show-secrets"
    );
  });

  it("does not emit a leaf-command condition for a parent command", () => {
    expect(script).not.toContain("__fish_agentrelay_using_command config' -l");
  });

  it("throws on an unsafe command name rather than emitting it", () => {
    expect(() =>
      generateCompletion("fish", {
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
