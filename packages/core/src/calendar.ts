import type { RelayJob } from "./types.js";

/**
 * iCalendar (RFC 5545) export of the relay's *upcoming resume times* — the
 * calendar counterpart to `agentrelay next`/`upcoming`. Where those print the
 * schedule to a terminal, this emits a `.ics` document you can double-click,
 * import, or subscribe to so a job's reset window shows up as an event in your
 * calendar app ("when does my rate-limited task come back?").
 *
 * Everything here is pure (jobs in, string out) — no clock beyond an injected
 * `now`, no filesystem — so it's trivially unit-testable and the CLI layer
 * decides where the bytes go, mirroring `export`/`metrics`.
 */

/** Default PRODID advertised in the VCALENDAR (RFC 5545 §3.7.3). */
export const DEFAULT_ICAL_PRODID = "-//AgentRelay//Resume Schedule//EN";

/** Default VEVENT length: a short window around the reset instant. */
export const DEFAULT_ICAL_EVENT_MS = 5 * 60 * 1000;

export interface ICalendarOptions {
  /** Reference time (epoch ms) for DTSTAMP and past-event filtering. Default `Date.now()`. */
  now?: number;
  /** Also emit events whose reset time is already in the past (default: future only). */
  includePast?: boolean;
  /** How long each VEVENT lasts, in ms (DTEND = reset + this). Default {@link DEFAULT_ICAL_EVENT_MS}. */
  eventDurationMs?: number;
  /** Human-readable calendar name (X-WR-CALNAME). Omitted when unset. */
  calendarName?: string;
  /** PRODID advertised by the calendar. Default {@link DEFAULT_ICAL_PRODID}. */
  prodId?: string;
}

/** Zero-pad a number to `width` digits (dates/times are always non-negative). */
function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * Format an epoch-ms instant as an RFC 5545 UTC date-time value
 * (`YYYYMMDDTHHMMSSZ`). Always UTC so the calendar is timezone-unambiguous no
 * matter where the file is opened.
 */
export function formatICalTimestamp(ms: number): string {
  const d = new Date(ms);
  return (
    pad(d.getUTCFullYear(), 4) +
    pad(d.getUTCMonth() + 1, 2) +
    pad(d.getUTCDate(), 2) +
    "T" +
    pad(d.getUTCHours(), 2) +
    pad(d.getUTCMinutes(), 2) +
    pad(d.getUTCSeconds(), 2) +
    "Z"
  );
}

/**
 * Escape a string for use as an RFC 5545 TEXT value (§3.3.11): backslash,
 * newline, semicolon, and comma are the reserved characters. Backslash is
 * replaced first so the escapes we add aren't themselves re-escaped.
 */
export function escapeICalText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

/** UTF-8 byte length of a string, without pulling in Buffer (keeps core portable). */
function utf8ByteLength(str: string): number {
  let bytes = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x7f) bytes += 1;
    else if (cp <= 0x7ff) bytes += 2;
    else if (cp <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * Fold a content line to the RFC 5545 §3.1 limit of 75 octets, with each
 * continuation line beginning with a single space. Splits on code-point
 * boundaries (never inside a multi-byte UTF-8 sequence) and counts real octets,
 * so non-ASCII project names fold correctly. Returns the physical lines joined
 * by CRLF.
 */
export function foldICalLine(line: string): string {
  const MAX = 75;
  const parts: string[] = [];
  let current = "";
  let currentBytes = 0;
  let continuation = false;
  for (const ch of line) {
    const chBytes = utf8ByteLength(ch);
    // Continuation lines spend one octet on the leading space.
    const budget = continuation ? MAX - 1 : MAX;
    if (currentBytes + chBytes > budget) {
      parts.push(continuation ? ` ${current}` : current);
      current = "";
      currentBytes = 0;
      continuation = true;
    }
    current += ch;
    currentBytes += chBytes;
  }
  parts.push(continuation ? ` ${current}` : current);
  return parts.join("\r\n");
}

/**
 * Order two jobs the way the scheduler resumes them: earliest reset first, then
 * oldest `createdAt`, then id — a fully deterministic sort so the calendar's
 * event order is stable even when two jobs share a reset time.
 */
function compareByReset(a: RelayJob, b: RelayJob): number {
  const ra = Date.parse(a.resetAt as string);
  const rb = Date.parse(b.resetAt as string);
  if (ra !== rb) return ra - rb;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * The jobs that will produce a calendar event: those with a parseable `resetAt`,
 * dropping resets already in the past unless `includePast` is set. Returned in
 * resume order (see {@link compareByReset}) so callers can both count and render
 * from the same, deterministic list.
 */
export function selectCalendarJobs(
  jobs: RelayJob[],
  options: { now?: number; includePast?: boolean } = {}
): RelayJob[] {
  const now = options.now ?? Date.now();
  const includePast = options.includePast ?? false;
  return jobs
    .filter((job) => {
      if (job.resetAt === null) return false;
      const ms = Date.parse(job.resetAt);
      if (Number.isNaN(ms)) return false;
      return includePast || ms >= now;
    })
    .sort(compareByReset);
}

/** Build one VEVENT (as unfolded content lines) for a job with a known reset time. */
function eventLines(job: RelayJob, resetMs: number, nowMs: number, durationMs: number): string[] {
  const description = [
    `Job ${job.id}`,
    `Tool: ${job.tool}`,
    `Status: ${job.status}`,
    `Command: ${job.command.join(" ")}`,
  ].join("\n");
  return [
    "BEGIN:VEVENT",
    `UID:${escapeICalText(job.id)}@agentrelay`,
    `DTSTAMP:${formatICalTimestamp(nowMs)}`,
    `DTSTART:${formatICalTimestamp(resetMs)}`,
    `DTEND:${formatICalTimestamp(resetMs + durationMs)}`,
    `SUMMARY:${escapeICalText(`AgentRelay resume: ${job.project}`)}`,
    `DESCRIPTION:${escapeICalText(description)}`,
    "CATEGORIES:AgentRelay",
    "END:VEVENT",
  ];
}

/**
 * Render the relay's upcoming resume times as a self-contained iCalendar
 * document (RFC 5545). One VEVENT per job with a parseable, still-future reset
 * (broaden with `includePast`), ordered by resume time. The result always has
 * a valid VCALENDAR envelope — an empty schedule yields a header-only calendar,
 * not an error. Lines use CRLF and are folded to 75 octets per the spec.
 */
export function jobsToICalendar(jobs: RelayJob[], options: ICalendarOptions = {}): string {
  const now = options.now ?? Date.now();
  const durationMs = options.eventDurationMs ?? DEFAULT_ICAL_EVENT_MS;
  const prodId = options.prodId ?? DEFAULT_ICAL_PRODID;
  const selected = selectCalendarJobs(jobs, { now, includePast: options.includePast });

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${escapeICalText(prodId)}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  if (options.calendarName !== undefined && options.calendarName !== "") {
    lines.push(`X-WR-CALNAME:${escapeICalText(options.calendarName)}`);
  }
  for (const job of selected) {
    const resetMs = Date.parse(job.resetAt as string);
    lines.push(...eventLines(job, resetMs, now, durationMs));
  }
  lines.push("END:VCALENDAR");

  return `${lines.map(foldICalLine).join("\r\n")}\r\n`;
}
