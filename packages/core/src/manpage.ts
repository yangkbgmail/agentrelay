// Man page (roff) generation. `agentrelay` has grown a large command surface,
// and `--help` scrolls off the screen. A traditional Unix man page is the
// canonical way to ship reference docs that `man agentrelay` renders, `less`
// paginates, and packagers drop into `/usr/share/man/man1`.
//
// Like `completion.ts`, this module holds only the pure *rendering*: given a
// structured description of the program (a `ManPageSpec`), produce a valid
// section-1 roff man page as a string. The CLI derives the spec from the live
// commander program — command names, descriptions, and every option's flags and
// help text — so the page never drifts from the real command surface. The
// generator here is filesystem/commander-free, so it's deterministic and
// trivially unit-testable (the date is passed in, never read from the clock).

/** A single option/flag row, e.g. `-s, --status <list>` with its help text. */
export interface ManOptionSpec {
  /** The full flag spec as commander prints it, e.g. `-s, --status <list>`. */
  flags: string;
  /** One-line description of what the flag does. */
  description: string;
}

/** A (sub)command in the man-page tree. */
export interface ManCommandSpec {
  /** The command word, e.g. `status` or `init`. */
  name: string;
  /** One-line description of the command. */
  description: string;
  /** The command's argument sketch, e.g. `<shell>` or `[path]` (optional). */
  args?: string;
  /** The command's own options. */
  options: ManOptionSpec[];
  /** Nested subcommands, e.g. `config init` / `config show`. */
  subcommands?: ManCommandSpec[];
}

/** A `FILES` entry: a path the program reads/writes and what it holds. */
export interface ManFileSpec {
  path: string;
  description: string;
}

/** The whole program described well enough to render a reference man page. */
export interface ManPageSpec {
  /** The program/binary name, e.g. `agentrelay`. */
  program: string;
  /** Man section number (1 = user command). Defaults to 1. */
  section?: number;
  /** Program version string, shown in the header (optional). */
  version?: string;
  /** Publication date `YYYY-MM-DD` for the `.TH` header (optional). */
  date?: string;
  /** The `manual` field of the header, e.g. `User Commands`. */
  manual?: string;
  /** One-line NAME-section description (`program \- description`). */
  description: string;
  /** A longer DESCRIPTION paragraph. Falls back to `description` if omitted. */
  longDescription?: string;
  /** Global options accepted before any subcommand. */
  options: ManOptionSpec[];
  /** Top-level commands. */
  commands: ManCommandSpec[];
  /** Optional FILES section entries. */
  files?: ManFileSpec[];
  /** Optional SEE ALSO references (raw text, e.g. `agentrelay-completion(1)`). */
  seeAlso?: string[];
}

/**
 * Escape a run of text for safe interpolation into roff *content*. Roff's escape
 * character is the backslash, and a bare `-` renders as a typographic hyphen
 * rather than an ASCII minus (which matters for flags a reader copies). We turn
 * `\` into `\e` and `-` into `\-` so both survive verbatim.
 */
function escapeRoff(text: string): string {
  return text.replace(/\\/g, "\\e").replace(/-/g, "\\-");
}

/**
 * Emit `text` as a standalone roff text line. A line that *starts* with `.` or
 * `'` would be parsed as a control request, so we prefix a zero-width `\&` to
 * force it back to text. Blank input becomes a genuinely empty line.
 */
function textLine(text: string): string {
  const escaped = escapeRoff(text).trim();
  if (escaped.length === 0) return "";
  if (escaped.startsWith(".") || escaped.startsWith("'")) return `\\&${escaped}`;
  return escaped;
}

/** Render one `.TP` option paragraph: bold flags, then the description body. */
function optionParagraph(opt: ManOptionSpec): string[] {
  const lines = [".TP", `\\fB${escapeRoff(opt.flags)}\\fR`];
  const body = textLine(opt.description);
  lines.push(body.length > 0 ? body : "\\ ");
  return lines;
}

/** The `title` field of `.TH` is conventionally the upper-cased program name. */
function thTitle(program: string): string {
  return program.toUpperCase();
}

/** Compose the `source` field of the `.TH` header (`program version`). */
function thSource(spec: ManPageSpec): string {
  return spec.version ? `${spec.program} ${spec.version}` : spec.program;
}

/**
 * Render `command` (and any nested subcommands) as `.SS` subsections under the
 * COMMANDS section. `prefix` is the leading command path (empty at top level,
 * e.g. `config ` for a subcommand of `config`).
 */
function commandSection(command: ManCommandSpec, prefix: string): string[] {
  const lines: string[] = [];
  const path = `${prefix}${command.name}`;
  const heading = command.args ? `${path} ${command.args}` : path;
  lines.push(`.SS ${escapeRoff(heading)}`);
  const desc = textLine(command.description);
  if (desc.length > 0) lines.push(desc);

  for (const opt of command.options) lines.push(...optionParagraph(opt));

  for (const sub of command.subcommands ?? []) {
    lines.push(...commandSection(sub, `${path} `));
  }
  return lines;
}

/**
 * Generate a complete section-1 roff man page from `spec`. The result is ready to
 * pipe to a `.1` file (`agentrelay man > agentrelay.1`) and render with
 * `man ./agentrelay.1`.
 */
export function generateManPage(spec: ManPageSpec): string {
  if (spec.program.trim().length === 0) {
    throw new Error("Cannot generate man page: empty program name.");
  }
  const section = spec.section ?? 1;
  const manual = spec.manual ?? "User Commands";
  const date = spec.date ?? "";
  const lines: string[] = [];

  // Header. Quote every field so spaces (in source/manual) stay intact.
  lines.push(`.TH "${thTitle(spec.program)}" "${section}" "${date}" "${thSource(spec)}" "${manual}"`);

  // NAME
  lines.push(".SH NAME");
  lines.push(`${escapeRoff(spec.program)} \\- ${textLine(spec.description)}`);

  // SYNOPSIS
  lines.push(".SH SYNOPSIS");
  lines.push(`.B ${escapeRoff(spec.program)}`);
  lines.push("[\\fIOPTIONS\\fR] \\fICOMMAND\\fR [\\fIARGS\\fR]");

  // DESCRIPTION
  lines.push(".SH DESCRIPTION");
  const longDesc = textLine(spec.longDescription ?? spec.description);
  if (longDesc.length > 0) lines.push(longDesc);

  // GLOBAL OPTIONS
  if (spec.options.length > 0) {
    lines.push(".SH GLOBAL OPTIONS");
    for (const opt of spec.options) lines.push(...optionParagraph(opt));
  }

  // COMMANDS
  if (spec.commands.length > 0) {
    lines.push(".SH COMMANDS");
    for (const command of spec.commands) lines.push(...commandSection(command, ""));
  }

  // FILES
  if (spec.files && spec.files.length > 0) {
    lines.push(".SH FILES");
    for (const file of spec.files) {
      lines.push(".TP");
      lines.push(`\\fI${escapeRoff(file.path)}\\fR`);
      const body = textLine(file.description);
      lines.push(body.length > 0 ? body : "\\ ");
    }
  }

  // SEE ALSO
  if (spec.seeAlso && spec.seeAlso.length > 0) {
    lines.push(".SH SEE ALSO");
    lines.push(spec.seeAlso.map((ref) => escapeRoff(ref)).join(", "));
  }

  return `${lines.join("\n")}\n`;
}
