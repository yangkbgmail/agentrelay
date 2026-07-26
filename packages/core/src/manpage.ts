// Man page (section 1) generation. A CLI that wants to be packaged (Homebrew
// formulae, Debian/Arch packages) is expected to ship a `man agentrelay` page,
// and hand-writing troff by hand rots the moment a command or flag changes.
//
// Like `completion.ts`, this module holds only the pure *rendering*: given a
// description of the command tree (a `ManPageSpec`), produce a valid groff/troff
// man page as a string. The CLI derives the spec from the live commander program
// (so it never drifts from the real command surface) and prints the page; the
// generator here is filesystem/commander/clock-free so it's trivially
// unit-testable and deterministic — the `.TH` date is passed in, not read from
// the clock.

/** A single option (global or per-command) as it appears in the man page. */
export interface ManOption {
  /** The raw flag string, e.g. `-s, --status <statuses>`. */
  flags: string;
  /** Human description shown under the flag. */
  description: string;
}

/** A command (or subcommand) node in the man page's COMMANDS section. */
export interface ManCommand {
  /** The command word, e.g. `status` or `init`. */
  name: string;
  /** The argument portion of the usage line, e.g. `<command...>` (may be empty). */
  args: string;
  /** One-line description of what the command does. */
  description: string;
  /** Options this command accepts. */
  options: ManOption[];
  /** Nested subcommands (e.g. `config init`/`config show`); empty for leaf commands. */
  subcommands: ManCommand[];
}

/** A file this tool reads/writes, for the FILES section. */
export interface ManFile {
  /** Absolute or `~`-relative path. */
  path: string;
  /** What the file is for. */
  description: string;
}

/** The whole program's man page surface. */
export interface ManPageSpec {
  /** The program/binary name, e.g. `agentrelay`. */
  program: string;
  /** Man section number (1 for user commands). */
  section: number;
  /** Program version string, shown in the `.TH` header, e.g. `0.1.0`. */
  version: string;
  /** One-line program description (the NAME/DESCRIPTION text). */
  description: string;
  /** Date for the `.TH` header (e.g. `2026-07-26`) — passed in so rendering is deterministic. */
  date: string;
  /** Center-footer/manual name for the `.TH` header (default `User Commands`). */
  manual?: string;
  /** Global options accepted before any subcommand. */
  options: ManOption[];
  /** Top-level commands. */
  commands: ManCommand[];
  /** Files the tool reads/writes, for the FILES section (omitted if empty). */
  files?: ManFile[];
}

/**
 * Escape a run of text for safe inclusion in a troff document body. Backslash is
 * the troff escape char, so it must be doubled (`\e`); hyphen-minus is rendered
 * as `\-` per man-page convention so it copies/pastes as a real ASCII hyphen
 * (bare `-` can be typeset as a Unicode hyphen). Everything else is literal.
 */
export function escapeTroff(text: string): string {
  return text.replace(/\\/g, "\\e").replace(/-/g, "\\-");
}

/**
 * Emit a body text line, escaping it and guarding the troff gotcha where a line
 * beginning with `.` or `'` is parsed as a control request: prefix `\&` (a
 * zero-width non-printing char) so it renders as literal text.
 */
function textLine(text: string): string {
  const escaped = escapeTroff(text);
  if (escaped.startsWith(".") || escaped.startsWith("'")) return `\\&${escaped}`;
  return escaped;
}

/** Render one option as a `.TP` (tagged paragraph): bold flag line, then its description. */
function renderOption(opt: ManOption): string[] {
  const lines = [".TP", `.B ${escapeTroff(opt.flags)}`];
  lines.push(opt.description ? textLine(opt.description) : "\\ ");
  return lines;
}

/** The bold synopsis line for a command, e.g. `.B agentrelay run <command...>`. */
function commandSynopsis(program: string, path: string[], args: string): string {
  const invocation = [program, ...path].join(" ");
  const tail = args ? ` ${args}` : "";
  return `.B ${escapeTroff(invocation + tail)}`;
}

/** Render a subcommand as an indented block under its parent's subsection. */
function renderSubcommand(program: string, parent: string, sub: ManCommand): string[] {
  const lines: string[] = [".PP", commandSynopsis(program, [parent, sub.name], sub.args), ".RS 4"];
  if (sub.description) lines.push(textLine(sub.description));
  for (const opt of sub.options) lines.push(...renderOption(opt));
  lines.push(".RE");
  return lines;
}

/** Render a top-level command as a `.SS` subsection with synopsis, description, options, subcommands. */
function renderCommand(program: string, cmd: ManCommand): string[] {
  const lines: string[] = [`.SS ${escapeTroff(cmd.name)}`, commandSynopsis(program, [cmd.name], cmd.args)];
  if (cmd.description) {
    lines.push(".PP", textLine(cmd.description));
  }
  for (const opt of cmd.options) lines.push(...renderOption(opt));
  for (const sub of cmd.subcommands) lines.push(...renderSubcommand(program, cmd.name, sub));
  return lines;
}

/**
 * Generate a complete groff/troff man page (section 1) from `spec`. The returned
 * string is a self-contained document that `man ./agentrelay.1` or
 * `groff -man -Tascii` can render.
 */
export function generateManPage(spec: ManPageSpec): string {
  const title = spec.program.toUpperCase();
  const manual = spec.manual ?? "User Commands";
  const lines: string[] = [
    `.\\" Generated by ${spec.program} man. Do not edit by hand.`,
    `.TH ${escapeTroff(title)} ${spec.section} "${escapeTroff(spec.date)}" "${escapeTroff(`${spec.program} ${spec.version}`)}" "${escapeTroff(manual)}"`,
    ".SH NAME",
    `${escapeTroff(spec.program)} \\- ${textLine(spec.description)}`,
    ".SH SYNOPSIS",
    `.B ${escapeTroff(spec.program)}`,
    "[\\fIglobal options\\fR] \\fIcommand\\fR [\\fIargs\\fR]",
    ".SH DESCRIPTION",
    textLine(spec.description),
  ];

  if (spec.options.length > 0) {
    lines.push(".SH GLOBAL OPTIONS");
    for (const opt of spec.options) lines.push(...renderOption(opt));
  }

  if (spec.commands.length > 0) {
    lines.push(".SH COMMANDS");
    for (const cmd of spec.commands) lines.push(...renderCommand(spec.program, cmd));
  }

  if (spec.files && spec.files.length > 0) {
    lines.push(".SH FILES");
    for (const file of spec.files) {
      lines.push(".TP", `.I ${escapeTroff(file.path)}`, file.description ? textLine(file.description) : "\\ ");
    }
  }

  // Trailing newline so the file ends cleanly (troff and text tools expect it).
  return `${lines.join("\n")}\n`;
}
