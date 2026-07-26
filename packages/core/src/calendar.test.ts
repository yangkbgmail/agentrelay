import { describe, expect, it } from "vitest";
import {
  DEFAULT_ICAL_EVENT_MS,
  escapeICalText,
  foldICalLine,
  formatICalTimestamp,
  jobsToICalendar,
  selectCalendarJobs,
} from "./calendar.js";
import type { RelayJob } from "./types.js";

function makeJob(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    project: "acme",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/home/u/acme",
    status: "waiting_for_reset",
    resetAt: "2026-08-01T12:00:00.000Z",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T11:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

const NOW = Date.parse("2026-08-01T11:00:00.000Z");

describe("formatICalTimestamp", () => {
  it("renders an epoch-ms instant as a UTC RFC 5545 date-time", () => {
    expect(formatICalTimestamp(Date.parse("2026-08-01T12:34:56.000Z"))).toBe("20260801T123456Z");
  });

  it("zero-pads every field", () => {
    expect(formatICalTimestamp(Date.parse("2026-01-02T03:04:05.000Z"))).toBe("20260102T030405Z");
  });
});

describe("escapeICalText", () => {
  it("escapes backslash, newline, semicolon, and comma", () => {
    expect(escapeICalText("a\\b;c,d\ne")).toBe("a\\\\b\\;c\\,d\\ne");
  });

  it("escapes the backslash before adding its own escapes (no double-escape)", () => {
    // A literal comma must become "\," — not "\\," (which would read as backslash + comma).
    expect(escapeICalText(",")).toBe("\\,");
    expect(escapeICalText("\\")).toBe("\\\\");
  });

  it("normalizes CRLF and CR newlines to \\n", () => {
    expect(escapeICalText("a\r\nb\rc")).toBe("a\\nb\\nc");
  });
});

describe("foldICalLine", () => {
  it("leaves short lines untouched", () => {
    expect(foldICalLine("SUMMARY:hi")).toBe("SUMMARY:hi");
  });

  it("folds lines longer than 75 octets with a leading space on continuations", () => {
    const line = `X:${"a".repeat(100)}`;
    const folded = foldICalLine(line);
    const physical = folded.split("\r\n");
    expect(physical.length).toBeGreaterThan(1);
    // First physical line is at most 75 octets; continuations start with a space.
    expect(physical[0].length).toBeLessThanOrEqual(75);
    for (const cont of physical.slice(1)) {
      expect(cont.startsWith(" ")).toBe(true);
      expect(cont.length).toBeLessThanOrEqual(75);
    }
    // Unfolding (drop CRLF + the one leading space) restores the original.
    expect(physical.map((p, i) => (i === 0 ? p : p.slice(1))).join("")).toBe(line);
  });

  it("never splits inside a multi-byte character", () => {
    const line = `X:${"あ".repeat(40)}`; // each あ is 3 UTF-8 octets
    for (const physical of foldICalLine(line).split("\r\n")) {
      // A clean split leaves each physical line a valid string with whole chars.
      expect(physical).not.toContain("�");
    }
  });
});

describe("selectCalendarJobs", () => {
  it("keeps only jobs with a parseable reset time", () => {
    const jobs = [
      makeJob({ id: "a", resetAt: "2026-08-01T13:00:00.000Z" }),
      makeJob({ id: "b", resetAt: null }),
      makeJob({ id: "c", resetAt: "not-a-date" }),
    ];
    expect(selectCalendarJobs(jobs, { now: NOW }).map((j) => j.id)).toEqual(["a"]);
  });

  it("drops past resets by default but keeps them with includePast", () => {
    const jobs = [
      makeJob({ id: "future", resetAt: "2026-08-01T13:00:00.000Z" }),
      makeJob({ id: "past", resetAt: "2026-08-01T09:00:00.000Z" }),
    ];
    expect(selectCalendarJobs(jobs, { now: NOW }).map((j) => j.id)).toEqual(["future"]);
    expect(selectCalendarJobs(jobs, { now: NOW, includePast: true }).map((j) => j.id)).toEqual(["past", "future"]);
  });

  it("orders events by reset time, then createdAt, then id", () => {
    const jobs = [
      makeJob({ id: "late", resetAt: "2026-08-01T15:00:00.000Z" }),
      makeJob({ id: "early-b", resetAt: "2026-08-01T13:00:00.000Z", createdAt: "2026-08-01T10:30:00.000Z" }),
      makeJob({ id: "early-a", resetAt: "2026-08-01T13:00:00.000Z", createdAt: "2026-08-01T10:00:00.000Z" }),
    ];
    expect(selectCalendarJobs(jobs, { now: NOW }).map((j) => j.id)).toEqual(["early-a", "early-b", "late"]);
  });
});

describe("jobsToICalendar", () => {
  it("wraps events in a valid VCALENDAR envelope with CRLF line endings", () => {
    const ics = jobsToICalendar([makeJob({ resetAt: "2026-08-01T13:00:00.000Z" })], { now: NOW });
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("VERSION:2.0\r\n");
    expect(ics).toContain("PRODID:-//AgentRelay//Resume Schedule//EN\r\n");
  });

  it("emits one VEVENT per selected job with DTSTART/DTEND from the reset", () => {
    const ics = jobsToICalendar([makeJob({ id: "job1", resetAt: "2026-08-01T13:00:00.000Z" })], { now: NOW });
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics).toContain("UID:job1@agentrelay\r\n");
    expect(ics).toContain("DTSTART:20260801T130000Z\r\n");
    const end = formatICalTimestamp(Date.parse("2026-08-01T13:00:00.000Z") + DEFAULT_ICAL_EVENT_MS);
    expect(ics).toContain(`DTEND:${end}\r\n`);
    expect(ics).toContain("DTSTAMP:20260801T110000Z\r\n");
  });

  it("yields a header-only calendar (no VEVENT) when nothing is upcoming", () => {
    const ics = jobsToICalendar([makeJob({ resetAt: null })], { now: NOW });
    expect(ics).not.toContain("BEGIN:VEVENT");
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
  });

  it("escapes special characters in the summary and description", () => {
    const ics = jobsToICalendar(
      [makeJob({ project: "a,b;c", command: ["sh", "-c", "echo hi"], resetAt: "2026-08-01T13:00:00.000Z" })],
      { now: NOW }
    );
    expect(ics).toContain("SUMMARY:AgentRelay resume: a\\,b\\;c\r\n");
    // Multi-line DESCRIPTION collapses to escaped \n and folds; the command shows up.
    expect(ics).toContain("Command: sh -c echo hi");
  });

  it("adds X-WR-CALNAME only when a calendar name is given", () => {
    const withName = jobsToICalendar([], { now: NOW, calendarName: "My relay" });
    expect(withName).toContain("X-WR-CALNAME:My relay\r\n");
    const withoutName = jobsToICalendar([], { now: NOW });
    expect(withoutName).not.toContain("X-WR-CALNAME");
  });

  it("honors includePast", () => {
    const jobs = [makeJob({ id: "past", resetAt: "2026-08-01T09:00:00.000Z" })];
    expect(jobsToICalendar(jobs, { now: NOW })).not.toContain("BEGIN:VEVENT");
    expect(jobsToICalendar(jobs, { now: NOW, includePast: true })).toContain("UID:past@agentrelay");
  });
});
