// Shell completion script generation. Users type `agentrelay <TAB>` a lot —
// completing subcommand names (`status`, `stats`, `restore`, …) and flags
// (`--json`, `--since`, …) is a classic CLI quality-of-life feature, and the
// only way to get it is to hand the shell a completion script.
//
// This module holds only the pure *rendering*: given a description of the
// command tree (a `CompletionSpec`), produce a valid bash, zsh, fish, or
// PowerShell completion script as a string. The CLI derives the spec from the
// live commander program (so it never drifts from the real command surface) and
// prints the script; the generator here is filesystem/commander-free so it's
// trivially unit-testable and deterministic.

/** Shells we can emit a completion script for. */
export type CompletionShell = "bash" | "zsh" | "fish" | "powershell";

/** Every shell `agentrelay completion` accepts, in a stable order. */
export const COMPLETION_SHELLS: readonly CompletionShell[] = ["bash", "zsh", "fish", "powershell"] as const;

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
  if (shell === "powershell") return generatePowerShell(spec);
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
 * Map an option flag to the token(s) a fish `complete` line expects. Fish wants
 * the flag *without* its leading dashes, tagged by kind: `-l` for a long option
 * (`--json` → `-l json`), `-s` for a single-char short (`-r` → `-s r`), and
 * `-o` for the rare old-style multi-char single-dash flag (`-foo` → `-o foo`).
 * The caller has already run `assertSafeToken` on the whole flag, so the stem is
 * a bare word.
 */
function fishOptionSpec(flag: string): string {
  if (flag.startsWith("--")) return `-l ${flag.slice(2)}`;
  if (flag.startsWith("-") && flag.length === 2) return `-s ${flag.slice(1)}`;
  if (flag.startsWith("-")) return `-o ${flag.slice(1)}`;
  // No leading dash at all: treat as a long option so it still completes.
  return `-l ${flag}`;
}

/**
 * Fish: a series of `complete -c` registrations rather than one dispatch
 * function. Fish's own `__fish_use_subcommand` / `__fish_seen_subcommand_from`
 * conditions decide when each candidate applies — top-level subcommands and
 * global options before a command is chosen, then that command's flags (or a
 * parent command's nested subcommands and their flags) once it's on the line.
 */
function generateFish(spec: CompletionSpec): string {
  const p = spec.program;
  for (const c of spec.commands) {
    assertSafeToken(c.name, "command name");
    for (const s of c.subcommands ?? []) assertSafeToken(s.name, "subcommand name");
  }

  const lines: string[] = [
    `# fish completion for ${p}`,
    `# Install: save this file as ~/.config/fish/completions/${p}.fish,`,
    `# or load it now with: ${p} completion fish | source`,
    "",
    "# Disable file completion by default; nothing here completes filenames.",
    `complete -c ${p} -f`,
    "",
  ];

  // Global options: offered while no subcommand is present yet.
  const globalOpts = uniq([...spec.options, "--help", "--version"].filter((o) => o.length > 0));
  for (const o of globalOpts) assertSafeToken(o, "global option");
  lines.push("# Global options (before any subcommand).");
  for (const o of globalOpts) {
    lines.push(`complete -c ${p} -n __fish_use_subcommand ${fishOptionSpec(o)}`);
  }
  lines.push("");

  // Top-level subcommands.
  lines.push("# Top-level subcommands.");
  for (const c of spec.commands) {
    lines.push(`complete -c ${p} -n __fish_use_subcommand -a ${c.name}`);
  }
  lines.push("");

  // Per-command options, or a parent command's nested subcommands + their flags.
  for (const cmd of spec.commands) {
    const subs = cmd.subcommands ?? [];
    if (subs.length > 0) {
      const subNames = subs.map((s) => s.name);
      lines.push(`# ${cmd.name} subcommands and their options.`);
      // Offer the subcommand names while the parent is seen but no sub yet.
      const guard = `__fish_seen_subcommand_from ${cmd.name}; and not __fish_seen_subcommand_from ${subNames.join(" ")}`;
      for (const s of subNames) {
        lines.push(`complete -c ${p} -n '${guard}' -a ${s}`);
      }
      for (const s of subs) {
        const opts = uniq([...s.options, "--help"].filter((o) => o.length > 0));
        for (const o of opts) assertSafeToken(o, "subcommand option");
        for (const o of opts) {
          lines.push(`complete -c ${p} -n '__fish_seen_subcommand_from ${s.name}' ${fishOptionSpec(o)}`);
        }
      }
      lines.push("");
    } else {
      const opts = uniq([...cmd.options, "--help"].filter((o) => o.length > 0));
      for (const o of opts) assertSafeToken(o, "command option");
      lines.push(`# ${cmd.name} options.`);
      for (const o of opts) {
        lines.push(`complete -c ${p} -n '__fish_seen_subcommand_from ${cmd.name}' ${fishOptionSpec(o)}`);
      }
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Render a PowerShell single-quoted string array literal, e.g.
 * `@('run', 'status')`. Every element has already passed {@link assertSafeToken}
 * (bare `[A-Za-z0-9_.:-]` words), so single-quoting is safe: PowerShell
 * single-quoted strings are fully literal, and the tokens contain no quote to
 * escape. An empty list renders as `@()`.
 */
function psList(words: string[]): string {
  if (words.length === 0) return "@()";
  return `@(${words.map((w) => `'${w}'`).join(", ")})`;
}

/**
 * PowerShell: a `Register-ArgumentCompleter -Native` script block. Unlike the
 * POSIX shells (a `complete`/`compdef`/`complete -c` mechanism each), PowerShell
 * gives the completer the whole command AST, so we walk `CommandElements` to find
 * the first non-option word after the program (the subcommand), then `switch` on
 * it to offer that command's flags — or, for a parent command like `config`, its
 * nested subcommand names (until one is chosen) and then that subcommand's flags.
 * At the start of the line we offer the top-level commands, or the global options
 * when the current word already starts with `-`. Works in Windows PowerShell 5.1
 * and PowerShell (pwsh) 7+.
 */
function generatePowerShell(spec: CompletionSpec): string {
  const p = spec.program;
  const commandNames = uniq(spec.commands.map((c) => c.name));
  for (const c of commandNames) assertSafeToken(c, "command name");
  const globalOpts = uniq([...spec.options, "--help", "--version"].filter((o) => o.length > 0));
  for (const o of globalOpts) assertSafeToken(o, "global option");

  const caseArms: string[] = [];
  for (const cmd of spec.commands) {
    const subs = cmd.subcommands ?? [];
    if (subs.length > 0) {
      const subNames = uniq(subs.map((s) => s.name));
      for (const s of subNames) assertSafeToken(s, "subcommand name");
      const subArms = subs
        .map((s) => {
          const subOpts = uniq([...s.options, "--help"].filter((o) => o.length > 0));
          for (const o of subOpts) assertSafeToken(o, "subcommand option");
          return `                '${s.name}' { $candidates = ${psList(subOpts)} }`;
        })
        .join("\n");
      caseArms.push(
        `        '${cmd.name}' {
            $sub = ''
            for ($j = $ci + 1; $j -lt $tokens.Count; $j++) {
                if ($tokens[$j] -notlike '-*') { $sub = $tokens[$j]; break }
            }
            switch ($sub) {
${subArms}
                default { $candidates = ${psList([...subNames, "--help"])} }
            }
        }`
      );
    } else {
      const opts = uniq([...cmd.options, "--help"].filter((o) => o.length > 0));
      for (const o of opts) assertSafeToken(o, "command option");
      caseArms.push(`        '${cmd.name}' { $candidates = ${psList(opts)} }`);
    }
  }

  return `# PowerShell completion for ${p}
# Install: add this to your $PROFILE, or load it now with:
#   ${p} completion powershell | Out-String | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName ${p} -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)

    $commands = ${psList(commandNames)}
    $globalOpts = ${psList(globalOpts)}

    $tokens = @($commandAst.CommandElements | ForEach-Object { $_.ToString() })

    # Locate the first non-option word after the program: that's the subcommand.
    $cmd = ''
    $ci = 0
    for ($i = 1; $i -lt $tokens.Count; $i++) {
        if ($tokens[$i] -notlike '-*') { $cmd = $tokens[$i]; $ci = $i; break }
    }

    $candidates = @()
    switch ($cmd) {
${caseArms.join("\n")}
        default {
            if ($wordToComplete -like '-*') { $candidates = $globalOpts }
            else { $candidates = $commands }
        }
    }

    $candidates | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
        [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
}
`;
}
