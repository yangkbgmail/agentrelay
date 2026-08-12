// Man page (roff/troff) generation. A local-first CLI that people install and
// keep around benefits from a real Unix man page: `agentrelay man > agentrelay.1`
// then `man ./agentrelay.1` (or drop it in a packaging `man/man1/` dir). Rather
// than hand-write and drift a `.1` file, we render one from the live command
// surface — the same idea as `completion`, but carrying descriptions too so the
// page is actually readable.
//
// This module holds only the pure *rendering*: given a `ManSpec` (program name,
// summary, global options, and the command tree with descriptions), produce a
// valid roff man page as a string. The CLI derives the spec from the live
// commander program and injects the date, so this generator is
// filesystem/commander/clock-free and trivially unit-testable and deterministic.

/** A single option row: the raw flags string plus its help text. */
export interface ManOption {
  /** The flags as commander reports them, e.g. `--json` or `-s, --status <list>`. */
  flags: string;
  /** The option's help text, if any. */
  description?: string;
}

/** A (sub)command in the man page: name, description, usage, options, nesting. */
export interface ManCommand {
  /** The command word, e.g. `status` or `init`. */
  name: string;
  /** One-line description shown under the command heading. */
  description?: string;
  /** Commander's usage suffix, e.g. `[options] <command...>`. */
  usage?: string;
  /** Options this command accepts. */
  options: ManOption[];
  /** Nested subcommands, e.g. `config init` / `config show`. */
  subcommands?: ManCommand[];
}

/** The whole program's man-page surface. */
export interface ManSpec {
  /** The program name (the binary), e.g. `agentrelay`. */
  program: string;
  /** Program version, e.g. `0.1.0` (used in the footer/source field). */
  version?: string;
  /** One-line program summary for NAME/DESCRIPTION. */
  summary?: string;
  /** Global options accepted before any subcommand. */
  options: ManOption[];
  /** Top-level subcommands. */
  commands: ManCommand[];
}

/** Knobs the CLI supplies (clock/format) so the core stays pure. */
export interface ManPageOptions {
  /** Manual section number (default 1 — user commands). */
  section?: number;
  /** Date for the `.TH` header, e.g. `2026-08-12`. Injected so core is clock-free. */
  date?: string;
  /** Center-header manual title (default `User Commands`). */
  manual?: string;
  /** Left-footer source string (default `<program> <version>`). */
  source?: string;
}

/**
 * Escape text for safe inline use in a roff document. Backslash is roff's escape
 * character, so a literal one becomes `\e`; a hyphen becomes `\-` so option flags
 * render as a minus rather than a typographic hyphen (the standard man-page
 * convention). Order matters: escape backslashes first so we don't double-escape
 * the ones we introduce.
 */
export function escapeRoff(text: string): string {
  return text.replace(/\\/g, "\\e").replace(/-/g, "\\-");
}

/**
 * Escape a line of body text and guard the roff "control line" footgun: a line
 * beginning with `.` or `'` is parsed as a request, so prefix such lines with the
 * zero-width `\&` to force them to render as literal text.
 */
function roffLine(text: string): string {
  const escaped = escapeRoff(text);
  return /^[.']/.test(escaped) ? `\\&${escaped}` : escaped;
}

/**
 * Sanitize a value going inside a double-quoted `.TH` field (drop quotes/newlines,
 * escape backslashes). Unlike body text we do *not* hyphen-escape here: these are
 * metadata fields (date, source, manual), where a literal `-` in `2026-08-12`
 * reads better than roff's `\-`.
 */
function thField(text: string): string {
  return text
    .replace(/["\r\n]+/g, " ")
    .trim()
    .replace(/\\/g, "\\e");
}

/** Render one option as a `.TP` (tagged paragraph): bold flags, then help text. */
function renderOption(opt: ManOption, out: string[]): void {
  out.push(".TP");
  out.push(`.B ${escapeRoff(opt.flags)}`);
  const desc = opt.description?.trim();
  out.push(desc ? roffLine(desc) : "(no description)");
}

/** Render a command (and its subcommands) as an `.SS` subsection block. */
function renderCommand(cmd: ManCommand, out: string[]): void {
  const usage = cmd.usage?.trim();
  const heading = usage ? `${cmd.name} ${usage}` : cmd.name;
  out.push(`.SS ${escapeRoff(heading)}`);
  const desc = cmd.description?.trim();
  if (desc) out.push(roffLine(desc));
  for (const opt of cmd.options) renderOption(opt, out);
  for (const sub of cmd.subcommands ?? []) {
    const subUsage = sub.usage?.trim();
    const subHeading = `${cmd.name} ${sub.name}${subUsage ? ` ${subUsage}` : ""}`;
    out.push(`.SS ${escapeRoff(subHeading)}`);
    const subDesc = sub.description?.trim();
    if (subDesc) out.push(roffLine(subDesc));
    for (const opt of sub.options) renderOption(opt, out);
  }
}

/**
 * Generate a complete roff man page for `spec`. The output is deterministic given
 * the same spec and options (the date is injected, never read from the clock), so
 * it's safe to snapshot in tests and to regenerate reproducibly.
 */
export function generateManPage(spec: ManSpec, options: ManPageOptions = {}): string {
  const section = options.section ?? 1;
  const title = spec.program.toUpperCase();
  const date = thField(options.date ?? "");
  const version = spec.version?.trim() ?? "";
  const source = thField(options.source ?? (version ? `${spec.program} ${version}` : spec.program));
  const manual = thField(options.manual ?? "User Commands");
  const summary = spec.summary?.trim() ?? "";

  const out: string[] = [];
  out.push(`.TH ${title} ${section} "${date}" "${source}" "${manual}"`);

  out.push(".SH NAME");
  out.push(summary ? `${escapeRoff(spec.program)} \\- ${escapeRoff(summary)}` : escapeRoff(spec.program));

  out.push(".SH SYNOPSIS");
  out.push(`.B ${escapeRoff(spec.program)}`);
  out.push("[\\fIglobal options\\fR] \\fIcommand\\fR [\\fIargs\\fR...]");

  if (summary) {
    out.push(".SH DESCRIPTION");
    out.push(roffLine(summary));
  }

  if (spec.options.length > 0) {
    out.push(".SH GLOBAL OPTIONS");
    for (const opt of spec.options) renderOption(opt, out);
  }

  if (spec.commands.length > 0) {
    out.push(".SH COMMANDS");
    for (const cmd of spec.commands) renderCommand(cmd, out);
  }

  // Trailing newline so the file is a well-formed text file.
  return `${out.join("\n")}\n`;
}
