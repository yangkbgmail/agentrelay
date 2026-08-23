import type { RelayJob } from "./types.js";

/**
 * iCalendar (RFC 5545) export of the relay's resume runway. Every job parked in
 * `waiting_for_reset` has a *future instant* it will resume at (`resetAt`); this
 * module turns that runway into a `.ics` a user can import into — or subscribe
 * to from — any calendar app (Apple Calendar, Google Calendar, Outlook, …). So
 * the same "when will my agents wake up?" question the CLI answers in the
 * terminal (`agentrelay upcoming`) is now answerable from the calendar the user
 * already lives in, with an optional alarm that fires the moment a job resumes.
 *
 * Everything here is pure (jobs in, string out) and takes an injected `now`, so
 * the output is byte-for-byte deterministic and unit-testable without a clock or
 * the filesystem — the CLI layer decides where the bytes go. Zero dependencies:
 * iCalendar is a plain text format, matching the repo's "no native deps" stance.
 */

/** The one job status that carries a live, future resume instant worth charting. */
const CALENDAR_STATUS: RelayJob["status"] = "waiting_for_reset";

export interface CalendarOptions {
  /**
   * "Now", used for each event's `DTSTAMP` (when the calendar entry was
   * generated). Injectable for deterministic tests; defaults to `new Date()`.
   */
  now?: Date;
  /**
   * `PRODID` advertised in the calendar header. Defaults to a stable AgentRelay
   * identifier; overridable so an embedder can brand its own export.
   */
  prodId?: string;
  /** `X-WR-CALNAME` (the calendar's display name in most apps). */
  calendarName?: string;
  /**
   * When true (the default), each event carries a `VALARM` that fires a display
   * notification at the reset instant — so the calendar itself pings you the
   * moment a rate-limited agent is due to resume. Set false for a plain,
   * alarm-free calendar (e.g. a shared read-only overview).
   */
  withAlarm?: boolean;
}

/** Default product identifier stamped into the `PRODID` header. */
export const DEFAULT_ICS_PRODID = "-//AgentRelay//Reset Calendar//EN";
/** Default calendar display name. */
export const DEFAULT_ICS_CALNAME = "AgentRelay resumes";

/**
 * The jobs a reset calendar charts: those `waiting_for_reset` with a parseable
 * `resetAt`, sorted by reset instant (then `createdAt`, then id) so the export
 * is stable across runs. Mirrors the selection `agentrelay upcoming` shows, so
 * the calendar and the terminal timeline never disagree about the runway. A job
 * with an unparseable `resetAt` is skipped rather than emitted at a bogus time —
 * the same "never resume at a wild instant" guard the parser applies.
 */
export function selectCalendarJobs(jobs: RelayJob[]): RelayJob[] {
  return jobs
    .filter((job) => job.status === CALENDAR_STATUS && job.resetAt !== null && !Number.isNaN(Date.parse(job.resetAt)))
    .sort((a, b) => {
      const ra = Date.parse(a.resetAt as string);
      const rb = Date.parse(b.resetAt as string);
      if (ra !== rb) return ra - rb;
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      if (a.id === b.id) return 0;
      return a.id < b.id ? -1 : 1;
    });
}

/**
 * Format a `Date` as an RFC 5545 UTC date-time: `YYYYMMDDTHHMMSSZ`. All emitted
 * timestamps are UTC (the trailing `Z`), so the calendar is unambiguous no
 * matter what timezone the importing client sits in.
 */
export function formatIcsUtc(date: Date): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${p2(date.getUTCMonth() + 1)}${p2(date.getUTCDate())}` +
    `T${p2(date.getUTCHours())}${p2(date.getUTCMinutes())}${p2(date.getUTCSeconds())}Z`
  );
}

/**
 * Escape a string for an RFC 5545 TEXT value: backslash, semicolon, and comma
 * are backslash-escaped, and any newline becomes a literal `\n`. Colons are left
 * as-is (they're only special in property *names*, not TEXT values).
 */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Fold one content line to the RFC 5545 75-octet limit: when a line exceeds 75
 * UTF-8 bytes it is split with CRLF + a single leading space, and folding counts
 * *bytes* (not chars) and never splits a multi-byte character. Returns the line
 * with any needed folds already inserted (CRLF-joined internally); the caller
 * joins whole lines with CRLF.
 */
export function foldIcsLine(line: string): string {
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  for (const char of line) {
    const charBytes = Buffer.byteLength(char, "utf8");
    // A continuation line begins with a space (1 byte already used), so the fold
    // threshold is the same 75-octet cap on the physical line.
    if (bytes + charBytes > 75) {
      out.push(current);
      current = ` ${char}`;
      bytes = 1 + charBytes;
    } else {
      current += char;
      bytes += charBytes;
    }
  }
  out.push(current);
  return out.join("\r\n");
}

/** Human-readable one-line SUMMARY for a job's resume event. */
function eventSummary(job: RelayJob): string {
  return `AgentRelay: resume ${job.project}`;
}

/** Multi-line DESCRIPTION: the context a user needs to recognize the job. */
function eventDescription(job: RelayJob): string {
  const lines = [
    `Tool: ${job.tool}`,
    `Command: ${job.command.join(" ")}`,
    `Working dir: ${job.cwd}`,
    `Attempts so far: ${job.attempts}`,
    `Job id: ${job.id}`,
  ];
  if (job.lastRateLimit) {
    lines.push(`Detected via: ${job.lastRateLimit.pattern}`);
  }
  return lines.join("\n");
}

/**
 * Build a complete iCalendar (`VCALENDAR`) document for the relay's resume
 * runway. One `VEVENT` per {@link selectCalendarJobs} entry, each a zero-length
 * event at the job's UTC `resetAt` (per RFC 5545, a `VEVENT` with `DTSTART` but
 * no `DTEND`/`DURATION` is an instantaneous event — exactly the "resume happens
 * at this instant" semantics we want). Lines are CRLF-terminated and folded to
 * 75 octets, so the output validates as strict iCalendar. Returns a calendar
 * with zero events (still a valid document) when nothing is waiting.
 */
export function buildResetCalendar(jobs: RelayJob[], options: CalendarOptions = {}): string {
  const now = options.now ?? new Date();
  const prodId = options.prodId ?? DEFAULT_ICS_PRODID;
  const calName = options.calendarName ?? DEFAULT_ICS_CALNAME;
  const withAlarm = options.withAlarm ?? true;
  const dtstamp = formatIcsUtc(now);

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${escapeIcsText(prodId)}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(calName)}`,
  ];

  for (const job of selectCalendarJobs(jobs)) {
    const dtstart = formatIcsUtc(new Date(job.resetAt as string));
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeIcsText(job.id)}@agentrelay`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART:${dtstart}`,
      `SUMMARY:${escapeIcsText(eventSummary(job))}`,
      `DESCRIPTION:${escapeIcsText(eventDescription(job))}`,
      "CATEGORIES:AGENTRELAY",
      "TRANSP:TRANSPARENT"
    );
    if (withAlarm) {
      lines.push(
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        `DESCRIPTION:${escapeIcsText(eventSummary(job))}`,
        "TRIGGER:PT0M",
        "END:VALARM"
      );
    }
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine).join("\r\n");
}
