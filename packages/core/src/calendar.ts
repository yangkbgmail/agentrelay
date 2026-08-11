import type { RelayJob } from "./types.js";
import { buildUpcomingTimeline } from "./upcoming.js";

/**
 * Emits the relay's upcoming-resume schedule as an RFC 5545 iCalendar
 * (`.ics`) document, so the answer to "when will my agents resume?" is
 * portable into any calendar app (Google Calendar, Apple Calendar, Outlook)
 * or served as a subscribable feed.
 *
 * Where `next`/`upcoming`/`eta` render the schedule for a terminal, this
 * renders the *same* set — every `waiting_for_reset` job with a parseable
 * `resetAt`, in the exact scheduler order (see {@link buildUpcomingTimeline}) —
 * as one `VEVENT` per job, timed at its reset instant. Pure and non-mutating:
 * no filesystem, and the only clock use is the injected `now` for the
 * `DTSTAMP` field (the events themselves are absolute reset instants), so the
 * output is fully deterministic in tests.
 */

export interface CalendarOptions {
  /** Injected "now" (epoch ms) stamped as each event's `DTSTAMP`. Defaults to `Date.now()`. */
  now?: number;
  /**
   * How long each resume event lasts, in minutes (default 15). A resume is an
   * instant, but calendars want a span; a short block keeps the schedule
   * readable without implying the agent runs for that whole time.
   */
  durationMinutes?: number;
  /** `X-WR-CALNAME` shown as the calendar's display name. Default "AgentRelay resumes". */
  calendarName?: string;
  /** `PRODID` identifying the generator. Default "-//AgentRelay//Resume Schedule//EN". */
  prodId?: string;
}

export interface CalendarResult {
  /** The full VCALENDAR document, CRLF-terminated per RFC 5545. */
  ics: string;
  /** How many `VEVENT`s were emitted (one per waiting job). */
  eventCount: number;
}

const DEFAULT_DURATION_MINUTES = 15;
const DEFAULT_CALENDAR_NAME = "AgentRelay resumes";
const DEFAULT_PRODID = "-//AgentRelay//Resume Schedule//EN";

/** Line-fold octet ceiling per RFC 5545 §3.1 (75 octets, CRLF + a leading space continues). */
const MAX_LINE_OCTETS = 75;

const TWO = (n: number): string => String(n).padStart(2, "0");

/**
 * Format an epoch-ms instant as an RFC 5545 UTC date-time value
 * (`YYYYMMDDTHHMMSSZ`). Exported for direct testing.
 */
export function formatIcsUtc(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}${TWO(d.getUTCMonth() + 1)}${TWO(d.getUTCDate())}` +
    `T${TWO(d.getUTCHours())}${TWO(d.getUTCMinutes())}${TWO(d.getUTCSeconds())}Z`
  );
}

/**
 * Escape a text value for a `SUMMARY`/`DESCRIPTION`/`CATEGORIES` property per
 * RFC 5545 §3.3.11: backslash, semicolon and comma are escaped, and any CR/LF
 * becomes a literal `\n`. Exported for direct testing.
 */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** UTF-8 byte length of a single code point (used for octet-accurate folding). */
function utf8Len(codePoint: string): number {
  const cp = codePoint.codePointAt(0) ?? 0;
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

/**
 * Fold one content line to the 75-octet limit (RFC 5545 §3.1): continuation
 * lines are joined with `CRLF` + a single space, and the fold never splits a
 * multi-byte UTF-8 sequence (we break on code-point boundaries). The leading
 * space on a continuation counts toward its own 75-octet budget. Exported for
 * direct testing.
 */
export function foldIcsLine(line: string): string {
  const out: string[] = [];
  let current = "";
  let octets = 0;
  // A continuation line starts with one space, so its content budget is 74.
  let budget = MAX_LINE_OCTETS;
  for (const ch of line) {
    const len = utf8Len(ch);
    if (octets + len > budget) {
      out.push(current);
      current = ch;
      octets = len;
      budget = MAX_LINE_OCTETS - 1; // leading space consumes one octet
    } else {
      current += ch;
      octets += len;
    }
  }
  out.push(current);
  return out.join("\r\n ");
}

/** Human-readable one-line command echo (space-joined), for the event description. */
function commandLine(command: string[]): string {
  return command.join(" ");
}

/** Build the VEVENT lines for a single waiting job. */
function eventLines(job: RelayJob, resetMs: number, dtstamp: string, durationMs: number): string[] {
  const start = formatIcsUtc(resetMs);
  const end = formatIcsUtc(resetMs + durationMs);
  const descriptionParts = [
    `${commandLine(job.command)}`,
    `tool ${job.tool} · attempt ${job.attempts}`,
    `job ${job.id}`,
  ];
  return [
    "BEGIN:VEVENT",
    // UID must be globally unique and stable across regenerations for the same
    // job, so a calendar updates rather than duplicates the event on re-sync.
    `UID:${job.id}@agentrelay`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${escapeIcsText(`AgentRelay resume: ${job.project}`)}`,
    `DESCRIPTION:${escapeIcsText(descriptionParts.join("\n"))}`,
    `CATEGORIES:${escapeIcsText(job.tool)}`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
  ];
}

/**
 * Render the upcoming-resume schedule as an iCalendar document. Selects the
 * same jobs as `upcoming` (via {@link buildUpcomingTimeline}) so the calendar,
 * the timeline and `next` never disagree about what's queued or in what order.
 * An empty queue still produces a valid (event-less) VCALENDAR.
 */
export function jobsToIcs(jobs: RelayJob[], options: CalendarOptions = {}): CalendarResult {
  const now = options.now ?? Date.now();
  const durationMinutes =
    typeof options.durationMinutes === "number" &&
    Number.isFinite(options.durationMinutes) &&
    options.durationMinutes > 0
      ? options.durationMinutes
      : DEFAULT_DURATION_MINUTES;
  const durationMs = durationMinutes * 60_000;
  const dtstamp = formatIcsUtc(now);
  const calendarName = options.calendarName ?? DEFAULT_CALENDAR_NAME;
  const prodId = options.prodId ?? DEFAULT_PRODID;

  const timeline = buildUpcomingTimeline(jobs, now);

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${escapeIcsText(prodId)}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
  ];

  for (const entry of timeline.entries) {
    const resetMs = Date.parse(entry.job.resetAt as string);
    lines.push(...eventLines(entry.job, resetMs, dtstamp, durationMs));
  }

  lines.push("END:VCALENDAR");

  const ics = `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
  return { ics, eventCount: timeline.entries.length };
}
