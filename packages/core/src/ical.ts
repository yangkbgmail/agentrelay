import type { RelayJob } from "./types.js";

// iCalendar (RFC 5545) export of the resume schedule.
//
// AgentRelay's whole value is knowing *when* a rate-limited job comes back — so
// the schedule is a natural thing to hand to a calendar app. This module turns
// the `waiting_for_reset` jobs into a VCALENDAR string (one VEVENT per reset)
// that any calendar client (Apple Calendar, Google Calendar, Outlook, …) can
// import or subscribe to, so "my refactor resumes at 3pm" shows up next to your
// meetings instead of only inside a terminal.
//
// Everything here is pure: given the job list and an injected `now` (for the
// DTSTAMP the spec requires on every event), it returns a deterministic string
// — no clock, no queue, no filesystem — so `agentrelay ical` is unit-testable
// end to end and byte-for-byte reproducible in tests.

/** Options controlling the generated calendar. All optional with sensible defaults. */
export interface IcalOptions {
  /** Epoch ms used for the DTSTAMP on every event (RFC 5545 requires one). Defaults to `Date.now()`. */
  now?: number;
  /** PRODID identifying the generator. Defaults to a stable agentrelay id. */
  prodId?: string;
  /** Human-readable calendar name (X-WR-CALNAME), shown by many clients. Defaults to "agentrelay resume schedule". */
  calName?: string;
  /**
   * Length of each resume event, in milliseconds, emitted as a DURATION.
   * A reset is an instant, but a zero-length event renders as a hard-to-see
   * point in most clients, so we give it a small default block. Defaults to
   * 5 minutes; clamp `<= 0` to omit DURATION (a point-in-time event).
   */
  durationMs?: number;
}

const DEFAULT_PROD_ID = "-//agentrelay//resume schedule//EN";
const DEFAULT_CAL_NAME = "agentrelay resume schedule";
const DEFAULT_DURATION_MS = 5 * 60 * 1000;

/**
 * The jobs a resume-schedule calendar should contain: every `waiting_for_reset`
 * job with a parseable `resetAt`, ordered by when it comes due (earliest reset,
 * then oldest `createdAt`, then id — the same deterministic tie-break as
 * `upcoming`/`next`, so the calendar mirrors the resume order the scheduler will
 * actually follow). Input is never mutated.
 */
export function selectSchedulableJobs(jobs: RelayJob[]): RelayJob[] {
  return jobs
    .filter(
      (job) => job.status === "waiting_for_reset" && job.resetAt !== null && !Number.isNaN(Date.parse(job.resetAt))
    )
    .slice()
    .sort((a, b) => {
      const ra = Date.parse(a.resetAt as string);
      const rb = Date.parse(b.resetAt as string);
      if (ra !== rb) return ra - rb;
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      if (a.id === b.id) return 0;
      return a.id < b.id ? -1 : 1;
    });
}

/** Format an epoch-ms instant as an RFC 5545 UTC date-time: `YYYYMMDDTHHMMSSZ`. */
export function formatIcalDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * Escape a value for an iCalendar TEXT property per RFC 5545 §3.3.11:
 * backslash, semicolon and comma are escaped, and newlines become the literal
 * `\n` sequence. Colons are left alone (only special in the property name).
 */
export function escapeIcalText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Fold a single content line to the 75-octet limit (RFC 5545 §3.1): a long line
 * is split with CRLF + a single leading space, never in the middle of a UTF-8
 * character. Continuation lines reserve one octet for that leading space.
 */
export function foldIcalLine(line: string): string {
  const segments: string[] = [];
  let current = "";
  let bytes = 0;
  let limit = 75; // first line gets the full 75; continuations reserve 1 for the space.
  for (const ch of line) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (bytes + chBytes > limit) {
      segments.push(current);
      current = ch;
      bytes = chBytes;
      limit = 74;
    } else {
      current += ch;
      bytes += chBytes;
    }
  }
  segments.push(current);
  return segments.join("\r\n ");
}

/** Format a millisecond span as an RFC 5545 DURATION (e.g. `PT5M`, `PT1H30M`, `PT0S`). */
function formatIcalDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  let out = "PT";
  if (hours > 0) out += `${hours}H`;
  if (minutes > 0) out += `${minutes}M`;
  if (seconds > 0 || (hours === 0 && minutes === 0)) out += `${seconds}S`;
  return out;
}

/** Build the SUMMARY line for a job's resume event, e.g. `Resume claude-code: my-app`. */
function eventSummary(job: RelayJob): string {
  return `Resume ${job.tool}: ${job.project}`;
}

/** Build the DESCRIPTION for a job's resume event: the command, cwd, and job id. */
function eventDescription(job: RelayJob): string {
  const command = job.command.join(" ");
  return `Command: ${command}\nDirectory: ${job.cwd}\nJob: ${job.id}`;
}

/**
 * Serialize the resume schedule as an iCalendar (RFC 5545) VCALENDAR string.
 *
 * One VEVENT is emitted per schedulable job (see {@link selectSchedulableJobs}),
 * with DTSTART at the parsed `resetAt`, a stable per-job UID so re-importing
 * updates the same event rather than duplicating it, and a small default
 * DURATION so the block is visible. When no jobs are waiting, a valid empty
 * VCALENDAR is returned. Lines use CRLF and are folded to 75 octets, so the
 * output is a spec-compliant `.ics` payload ready to write to a file or serve.
 */
export function jobsToIcal(jobs: RelayJob[], options: IcalOptions = {}): string {
  const now = options.now ?? Date.now();
  const prodId = options.prodId ?? DEFAULT_PROD_ID;
  const calName = options.calName ?? DEFAULT_CAL_NAME;
  const durationMs = options.durationMs ?? DEFAULT_DURATION_MS;
  const dtstamp = formatIcalDate(now);

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${escapeIcalText(prodId)}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcalText(calName)}`,
  ];

  for (const job of selectSchedulableJobs(jobs)) {
    const start = Date.parse(job.resetAt as string);
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${escapeIcalText(job.id)}@agentrelay`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART:${formatIcalDate(start)}`);
    if (durationMs > 0) lines.push(`DURATION:${formatIcalDuration(durationMs)}`);
    lines.push(`SUMMARY:${escapeIcalText(eventSummary(job))}`);
    lines.push(`DESCRIPTION:${escapeIcalText(eventDescription(job))}`);
    lines.push(`LOCATION:${escapeIcalText(job.cwd)}`);
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.map(foldIcalLine).join("\r\n");
}
