/**
 * Split a command-line *string* into an argv array, the way a POSIX shell would
 * for the simple cases — but without invoking a shell.
 *
 * AgentRelay stores commands as `string[]` (argv), never as a single string
 * handed to `/bin/sh`, so a spawned command is never re-interpreted by a shell
 * (no glob expansion, no `$VAR`, no `;`/`&&`). This helper exists for the one
 * place a human types a *whole command as one string* — `agentrelay run
 * --resume-with "claude --continue -p 'keep going'"` — and we need to turn that
 * into the argv the scheduler will spawn.
 *
 * Supported (and only this — deliberately small so behaviour is predictable):
 * - whitespace (space/tab/newline) separates tokens;
 * - single quotes `'…'` group verbatim (no escapes inside, as in a POSIX shell);
 * - double quotes `"…"` group, with `\` escaping only `"` and `\`;
 * - a bare backslash `\` outside quotes escapes the next character literally;
 * - quotes can abut text and each other (`a"b"'c'` → `abc`), and an empty
 *   quoted string (`""`) produces an empty argument.
 *
 * Explicitly NOT supported (these are shell features, not argv tokenizing):
 * variable/command substitution, globbing, operators (`|`, `&&`, `;`, `>`),
 * and backslash escapes inside single quotes. Such input isn't rejected — the
 * characters are taken literally — because the result is spawned directly, not
 * via a shell, so there's nothing to expand.
 *
 * @throws {Error} on an unterminated single- or double-quoted string, or a
 *   trailing backslash with nothing to escape, so a typo fails loudly at parse
 *   time instead of silently dropping part of the command.
 */
export function tokenizeCommandLine(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  // Whether `current` holds a real (possibly empty) token yet — set as soon as
  // any quote opens or any char is added, so `""` yields one empty argument.
  let hasToken = false;

  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];

    if (ch === "'") {
      hasToken = true;
      i++;
      const close = input.indexOf("'", i);
      if (close === -1) throw new Error("unterminated single quote in command string");
      current += input.slice(i, close);
      i = close + 1;
      continue;
    }

    if (ch === '"') {
      hasToken = true;
      i++;
      while (i < n && input[i] !== '"') {
        if (input[i] === "\\" && (input[i + 1] === '"' || input[i + 1] === "\\")) {
          current += input[i + 1];
          i += 2;
        } else {
          current += input[i];
          i++;
        }
      }
      if (i >= n) throw new Error("unterminated double quote in command string");
      i++; // consume closing quote
      continue;
    }

    if (ch === "\\") {
      if (i + 1 >= n) throw new Error("dangling backslash at end of command string");
      current += input[i + 1];
      hasToken = true;
      i += 2;
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      i++;
      continue;
    }

    current += ch;
    hasToken = true;
    i++;
  }

  if (hasToken) tokens.push(current);
  return tokens;
}
