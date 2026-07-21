// Shell completion script generation. Users type `agentrelay <TAB>` a lot —
// completing subcommand names (`status`, `stats`, `restore`, …) and flags
// (`--json`, `--since`, …) is a classic CLI quality-of-life feature, and the
// only way to get it is to hand the shell a completion script.
//
// This module holds only the pure *rendering*: given a description of the
// command tree (a `CompletionSpec`), produce a valid bash or zsh completion
// script as a string. The CLI derives the spec from the live commander program
// (so it never drifts from the real command surface) and prints the script; the
// generator here is filesystem/commander-free so it's trivially unit-testable
// and deterministic.

/** Shells we can emit a completion script for. */
export type CompletionShell = "bash" | "zsh" | "fish";

/** Every shell `agentrelay completion` accepts, in a stable order. */
export const COMPLETION_SHELLS: readonly CompletionShell[] = ["bash", "zsh", "fish"] as const;

/** Type guard: is `value` one of the shells we support? */
export function isCompletionShell(value: string): value is CompletionShell {
  return (COMPLETION_SHELLS as readonly string[]).includes(value);
}

/** A single (sub)command in the completion tree. */
export interface CompletionCommandSpec {
  /** The command word, e.g. `status` or `init`. */
  name: string;
  /** Long/short option flags this command accepts, e.g. `--json`, `-w`. */
  options: string[];
  /** Nested subcommands, e.g. `config init`/`config show`. */
  subcommands?: CompletionCommandSpec[];
}

/** The whole program's completion surface. */
export interface CompletionSpec {
  /** The program name (the binary being completed), e.g. `agentrelay`. */
  program: string;
  /** Global options accepted before any subcommand, e.g. `--store`, `--config`. */
  options: string[];
  /** Top-level subcommands. */
  commands: CompletionCommandSpec[];
}

/**
 * A shell identifier is only safe to interpolate into `case` labels and
 * function names if it's a bare word. Command/flag names in our CLI are all
 * simple (`[a-z-]+`, `--flag`), but we defend anyway: reject anything with
 * shell metacharacters so a future command name can never produce a script that
 * does something surprising when sourced.
 */
function assertSafeToken(token: string, kind: string): void {
  if (!/^[A-Za-z0-9_.:-]+$/.test(token)) {
    throw new Error(`Cannot generate completion: unsafe ${kind} "${token}".`);
  }
}

/** Dedupe while preserving first-seen order. */
function uniq(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/** Space-join a validated word list for embedding in a `compgen -W` set. */
function wordList(words: string[], kind: string): string {
  const cleaned = uniq(words.filter((w) => w.length > 0));
  for (const w of cleaned) assertSafeToken(w, kind);
  return cleaned.join(" ");
}

/**
 * Generate a completion script for `shell` from `spec`. The returned string is a
 * complete, self-contained script the user can `source` (bash) or drop on their
 * `$fpath` (zsh).
 */
export function generateCompletion(shell: CompletionShell, spec: CompletionSpec): string {
  assertSafeToken(spec.program, "program name");
  for (const cmd of spec.commands) {
    assertSafeToken(cmd.name, "command name");
    for (const sub of cmd.subcommands ?? []) assertSafeToken(sub.name, "subcommand name");
  }
  if (shell === "bash") return generateBash(spec);
  if (shell === "fish") return generateFish(spec);
  return generateZsh(spec);
}

/**
 * Bash: a `complete -F` function that figures out which subcommand is on the
 * line and offers that command's flags (or its nested subcommands), falling back
 * to the top-level command list / global options at the start of the line.
 */
function generateBash(spec: CompletionSpec): string {
  const fn = `_${spec.program.replace(/[^A-Za-z0-9_]/g, "_")}_completion`;
  const commandNames = wordList(
    spec.commands.map((c) => c.name),
    "command name"
  );
  const globalOpts = wordList([...spec.options, "--help", "--version"], "global option");

  const caseArms: string[] = [];
  for (const cmd of spec.commands) {
    const hasSubs = (cmd.subcommands?.length ?? 0) > 0;
    if (hasSubs) {
      // A parent command (e.g. `config`): complete its subcommand names, and
      // once a subcommand is present, that subcommand's flags.
      const subNames = wordList(
        (cmd.subcommands ?? []).map((s) => s.name),
        "subcommand name"
      );
      const subArms = (cmd.subcommands ?? [])
        .map((s) => {
          const subOpts = wordList([...s.options, "--help"], "subcommand option");
          return `        ${s.name}) __opts="${subOpts}" ;;`;
        })
        .join("\n");
      caseArms.push(
        `    ${cmd.name})
      local __sub=""
      local __j
      for (( __j=__ci+1; __j<cword; __j++ )); do
        case "\${words[__j]}" in
          -*) ;;
          *) __sub="\${words[__j]}"; break ;;
        esac
      done
      local __opts=""
      case "$__sub" in
${subArms}
        *) __opts="${subNames} --help" ;;
      esac
      COMPREPLY=( $(compgen -W "$__opts" -- "$cur") )
      ;;`
      );
    } else {
      const opts = wordList([...cmd.options, "--help"], "command option");
      caseArms.push(
        `    ${cmd.name})
      COMPREPLY=( $(compgen -W "${opts}" -- "$cur") )
      ;;`
      );
    }
  }

  return `# bash completion for ${spec.program}
# Install: source this file, or place it in your bash-completion.d directory.
${fn}() {
  local cur prev words cword
  if declare -F _init_completion >/dev/null 2>&1; then
    _init_completion || return
  else
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    words=("\${COMP_WORDS[@]}")
    cword=$COMP_CWORD
  fi

  local commands="${commandNames}"
  local global_opts="${globalOpts}"

  # Locate the first non-option word after the program: that's the subcommand.
  local __cmd=""
  local __ci=0
  local __i
  for (( __i=1; __i<cword; __i++ )); do
    case "\${words[__i]}" in
      -*) ;;
      *) __cmd="\${words[__i]}"; __ci=$__i; break ;;
    esac
  done

  if [[ -z "$__cmd" ]]; then
    if [[ "$cur" == -* ]]; then
      COMPREPLY=( $(compgen -W "$global_opts" -- "$cur") )
    else
      COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
    fi
    return 0
  fi

  case "$__cmd" in
${caseArms.join("\n")}
    *)
      COMPREPLY=( $(compgen -W "$global_opts" -- "$cur") )
      ;;
  esac
  return 0
}
complete -F ${fn} ${spec.program}
`;
}

/**
 * Zsh: a `#compdef` function that uses `_describe` to offer subcommands at the
 * top level and each command's flags once a command is present. Kept simple and
 * robust rather than exhaustively state-machined.
 */
function generateZsh(spec: CompletionSpec): string {
  const fn = `_${spec.program.replace(/[^A-Za-z0-9_]/g, "_")}`;
  const commandLines = spec.commands.map((c) => `    '${c.name}'`).join("\n");

  const caseArms: string[] = [];
  for (const cmd of spec.commands) {
    const hasSubs = (cmd.subcommands?.length ?? 0) > 0;
    if (hasSubs) {
      const subLines = (cmd.subcommands ?? []).map((s) => `        '${s.name}'`).join("\n");
      caseArms.push(
        `    ${cmd.name})
      local -a __subs
      __subs=(
${subLines}
      )
      _describe 'subcommand' __subs
      ;;`
      );
    } else {
      const opts = uniq([...cmd.options, "--help"].filter((o) => o.length > 0));
      for (const o of opts) assertSafeToken(o, "command option");
      const optLines = opts.map((o) => `        '${o}'`).join("\n");
      caseArms.push(
        `    ${cmd.name})
      local -a __opts
      __opts=(
${optLines}
      )
      _describe 'option' __opts
      ;;`
      );
    }
  }

  for (const c of spec.commands) assertSafeToken(c.name, "command name");

  return `#compdef ${spec.program}
# zsh completion for ${spec.program}
# Install: place this file as _${spec.program} on a directory in your $fpath.
${fn}() {
  local -a __commands
  __commands=(
${commandLines}
  )

  local __cmd=""
  local __i
  for (( __i=2; __i<CURRENT; __i++ )); do
    case "\${words[__i]}" in
      -*) ;;
      *) __cmd="\${words[__i]}"; break ;;
    esac
  done

  if [[ -z "$__cmd" ]]; then
    _describe 'command' __commands
    return
  fi

  case "$__cmd" in
${caseArms.join("\n")}
    *)
      _describe 'command' __commands
      ;;
  esac
}
${fn} "$@"
`;
}

/**
 * Map a single option token (`--json`, `-r`, `-xy`) to the `complete` fragment
 * fish expects: `-l json` (long), `-s r` (short, one char), or `-o xy`
 * (old-style single-dash, multi-char). Returns null for a token we can't
 * express (empty or a bare word) so the caller can skip it.
 */
function fishOptionFragment(opt: string): string | null {
  if (opt.startsWith("--")) {
    const name = opt.slice(2);
    if (name.length === 0) return null;
    assertSafeToken(name, "option");
    return `-l ${name}`;
  }
  if (opt.startsWith("-")) {
    const name = opt.slice(1);
    if (name.length === 0) return null;
    assertSafeToken(name, "option");
    return name.length === 1 ? `-s ${name}` : `-o ${name}`;
  }
  return null;
}

/**
 * Fish: a set of `complete` rules gated by small predicate functions. Unlike
 * bash/zsh (which walk the line inside one big function), fish drives each rule
 * from a `-n <condition>`; we emit helper functions that report which
 * command/subcommand is currently on the line and hang the rules off them. The
 * whole script is written to `~/.config/fish/completions/agentrelay.fish`.
 */
function generateFish(spec: CompletionSpec): string {
  const prog = spec.program;
  const helper = `__fish_${prog.replace(/[^A-Za-z0-9_]/g, "_")}`;
  const lines: string[] = [];

  lines.push(`# fish completion for ${prog}`);
  lines.push(`# Install: ${prog} completion fish > ~/.config/fish/completions/${prog}.fish`);
  lines.push("");

  // Helper: emit the non-option argument words after the program name, one per
  // line, so callers can capture them as a list with (…).
  lines.push(`function ${helper}_args`);
  lines.push("    set -l cmd (commandline -opc)");
  lines.push("    set -e cmd[1]");
  lines.push("    for word in $cmd");
  lines.push("        switch $word");
  lines.push("            case '-*'");
  lines.push("                continue");
  lines.push("            case '*'");
  lines.push("                echo $word");
  lines.push("        end");
  lines.push("    end");
  lines.push("end");
  lines.push("");
  lines.push(`function ${helper}_no_subcommand`);
  lines.push(`    set -l args (${helper}_args)`);
  lines.push("    test (count $args) -eq 0");
  lines.push("end");
  lines.push("");
  lines.push(`function ${helper}_using_command`);
  lines.push(`    set -l args (${helper}_args)`);
  lines.push('    test (count $args) -ge 1; and test "$args[1]" = "$argv[1]"');
  lines.push("end");
  lines.push("");
  lines.push(`function ${helper}_command_bare`);
  lines.push(`    set -l args (${helper}_args)`);
  lines.push('    test (count $args) -eq 1; and test "$args[1]" = "$argv[1]"');
  lines.push("end");
  lines.push("");
  lines.push(`function ${helper}_using_subcommand`);
  lines.push(`    set -l args (${helper}_args)`);
  lines.push('    test (count $args) -ge 2; and test "$args[1]" = "$argv[1]"; and test "$args[2]" = "$argv[2]"');
  lines.push("end");
  lines.push("");

  // Top-level command names (offered before any subcommand is on the line).
  const commandNames = wordList(
    spec.commands.map((c) => c.name),
    "command name"
  );
  if (commandNames.length > 0) {
    lines.push(`complete -c ${prog} -f -n '${helper}_no_subcommand' -a '${commandNames}'`);
  }
  // Global options, also only before a subcommand.
  for (const opt of uniq([...spec.options, "--help", "--version"])) {
    const frag = fishOptionFragment(opt);
    if (frag) lines.push(`complete -c ${prog} -n '${helper}_no_subcommand' ${frag}`);
  }
  lines.push("");

  for (const cmd of spec.commands) {
    const subs = cmd.subcommands ?? [];
    if (subs.length > 0) {
      // Parent command: offer subcommand names (and the parent's own flags)
      // only while the subcommand slot is still empty.
      const subNames = wordList(
        subs.map((s) => s.name),
        "subcommand name"
      );
      lines.push(`complete -c ${prog} -f -n '${helper}_command_bare ${cmd.name}' -a '${subNames}'`);
      for (const opt of uniq([...cmd.options, "--help"])) {
        const frag = fishOptionFragment(opt);
        if (frag) lines.push(`complete -c ${prog} -n '${helper}_command_bare ${cmd.name}' ${frag}`);
      }
      for (const sub of subs) {
        for (const opt of uniq([...sub.options, "--help"])) {
          const frag = fishOptionFragment(opt);
          if (frag) {
            lines.push(`complete -c ${prog} -n '${helper}_using_subcommand ${cmd.name} ${sub.name}' ${frag}`);
          }
        }
      }
    } else {
      // Leaf command: offer its flags whenever it's the active command.
      for (const opt of uniq([...cmd.options, "--help"])) {
        const frag = fishOptionFragment(opt);
        if (frag) lines.push(`complete -c ${prog} -n '${helper}_using_command ${cmd.name}' ${frag}`);
      }
    }
  }
  lines.push("");

  return `${lines.join("\n")}`;
}
