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
  it("COMPLETION_SHELLS lists bash, zsh, and nushell", () => {
    expect([...COMPLETION_SHELLS]).toEqual(["bash", "zsh", "nushell"]);
  });

  it("isCompletionShell accepts known shells and rejects others", () => {
    expect(isCompletionShell("bash")).toBe(true);
    expect(isCompletionShell("zsh")).toBe(true);
    expect(isCompletionShell("nushell")).toBe(true);
    expect(isCompletionShell("fish")).toBe(false);
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

describe("generateCompletion — nushell", () => {
  const script = generateCompletion("nushell", SPEC);

  it("starts with the nushell completion header", () => {
    expect(script.startsWith("# nushell completion for agentrelay")).toBe(true);
  });

  it("emits an extern for the program with global options plus help/version", () => {
    expect(script).toContain('export extern "agentrelay" [');
    expect(script).toContain("--store");
    expect(script).toContain("--config");
    expect(script).toContain("--version");
  });

  it("emits an extern per command carrying its long flags and --help", () => {
    expect(script).toContain('export extern "agentrelay run" [');
    expect(script).toContain('export extern "agentrelay status" [');
    // status flags, --help appended
    expect(script).toContain("--watch");
    expect(script).toContain("--help");
  });

  it("ends every signature with a ...rest catch-all so values pass through", () => {
    expect(script).toContain("...rest: string");
    // one per extern
    expect(script.match(/\.\.\.rest: string/g)?.length).toBe(script.match(/^export extern/gm)?.length);
  });

  it("drops bare short flags (no long/short pairing in the spec)", () => {
    // status carries -r; nushell can't render a bare short flag, so it's omitted.
    const statusBlock = script.slice(
      script.indexOf('export extern "agentrelay status"'),
      script.indexOf("]", script.indexOf('export extern "agentrelay status"'))
    );
    expect(statusBlock).not.toContain("-r");
    expect(statusBlock).toContain("--sort");
  });

  it("emits an extern per subcommand of a parent command", () => {
    expect(script).toContain('export extern "agentrelay config" [');
    expect(script).toContain('export extern "agentrelay config init" [');
    expect(script).toContain('export extern "agentrelay config validate" [');
    expect(script).toContain('export extern "agentrelay config show" [');
    // show's long flags survive; init's bare -f is dropped but --force stays.
    expect(script).toContain("--show-secrets");
    expect(script).toContain("--force");
  });

  it("dedupes repeated long flags while keeping first-seen order", () => {
    const dup = generateCompletion("nushell", {
      program: "x",
      options: [],
      commands: [{ name: "c", options: ["--json", "--json", "-j"] }],
    });
    const block = dup.slice(dup.indexOf('export extern "x c"'));
    expect(block.match(/--json/g)?.length).toBe(1);
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
