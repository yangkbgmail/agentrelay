import { describe, expect, it } from "vitest";
import {
  buildResetCalendar,
  DEFAULT_ICS_PRODID,
  escapeIcsText,
  foldIcsLine,
  formatIcsUtc,
  selectCalendarJobs,
} from "./ics.js";
import type { RelayJob } from "./types.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job-${seq}`,
    project: "alpha",
    tool: "claude-code",
    command: ["claude", "-p", "go"],
    cwd: "/tmp",
    status: "waiting_for_reset",
    resetAt: "2026-07-30T12:00:00.000Z",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

const NOW = new Date("2026-07-30T10:00:00.000Z");

/** Split a rendered calendar back into logical lines (unfolding continuations). */
function unfold(ics: string): string[] {
  return ics.replace(/\r\n[ \t]/g, "").split("\r\n");
}

describe("formatIcsUtc", () => {
  it("renders a UTC date-time as YYYYMMDDTHHMMSSZ", () => {
    expect(formatIcsUtc(new Date("2026-07-13T05:00:00.000Z"))).toBe("20260713T050000Z");
  });

  it("zero-pads every field", () => {
    expect(formatIcsUtc(new Date("2026-01-02T03:04:05.000Z"))).toBe("20260102T030405Z");
  });

  it("normalizes a non-UTC input to UTC", () => {
    expect(formatIcsUtc(new Date("2026-07-13T05:00:00+02:00"))).toBe("20260713T030000Z");
  });
});

describe("escapeIcsText", () => {
  it("escapes backslash, semicolon, and comma", () => {
    expect(escapeIcsText("a\\b;c,d")).toBe("a\\\\b\\;c\\,d");
  });

  it("turns newlines into literal \\n", () => {
    expect(escapeIcsText("line1\nline2\r\nline3")).toBe("line1\\nline2\\nline3");
  });

  it("leaves colons untouched", () => {
    expect(escapeIcsText("Tool: claude-code")).toBe("Tool: claude-code");
  });
});

describe("foldIcsLine", () => {
  it("leaves short lines untouched", () => {
    expect(foldIcsLine("SUMMARY:hello")).toBe("SUMMARY:hello");
  });

  it("folds a long line at 75 octets with a leading space", () => {
    const long = `DESCRIPTION:${"x".repeat(100)}`;
    const folded = foldIcsLine(long);
    const physical = folded.split("\r\n");
    expect(physical.length).toBeGreaterThan(1);
    for (const line of physical) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    }
    // Continuation lines start with a single space; unfolding restores the original.
    expect(physical.slice(1).every((l) => l.startsWith(" "))).toBe(true);
    expect(folded.replace(/\r\n /g, "")).toBe(long);
  });

  it("never splits a multi-byte character across a fold boundary", () => {
    const long = `SUMMARY:${"日".repeat(60)}`; // each 日 is 3 UTF-8 bytes
    const folded = foldIcsLine(long);
    for (const line of folded.split("\r\n")) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /g, "")).toBe(long);
  });
});

describe("selectCalendarJobs", () => {
  it("keeps only waiting_for_reset jobs with a parseable resetAt", () => {
    const kept = selectCalendarJobs([
      job({ id: "wait", status: "waiting_for_reset" }),
      job({ id: "done", status: "completed" }),
      job({ id: "queued", status: "queued" }),
      job({ id: "no-reset", status: "waiting_for_reset", resetAt: null }),
      job({ id: "bad-reset", status: "waiting_for_reset", resetAt: "not-a-date" }),
    ]);
    expect(kept.map((j) => j.id)).toEqual(["wait"]);
  });

  it("sorts by reset instant, then createdAt, then id", () => {
    const kept = selectCalendarJobs([
      job({ id: "late", resetAt: "2026-07-30T14:00:00.000Z" }),
      job({ id: "early", resetAt: "2026-07-30T11:00:00.000Z" }),
      job({ id: "mid-b", resetAt: "2026-07-30T12:00:00.000Z", createdAt: "2026-07-30T02:00:00.000Z" }),
      job({ id: "mid-a", resetAt: "2026-07-30T12:00:00.000Z", createdAt: "2026-07-30T01:00:00.000Z" }),
    ]);
    expect(kept.map((j) => j.id)).toEqual(["early", "mid-a", "mid-b", "late"]);
  });
});

describe("buildResetCalendar", () => {
  it("emits a valid, event-free VCALENDAR when nothing is waiting", () => {
    const ics = buildResetCalendar([], { now: NOW });
    const lines = unfold(ics);
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines).toContain("VERSION:2.0");
    expect(lines).toContain(`PRODID:${DEFAULT_ICS_PRODID}`);
    expect(lines.at(-1)).toBe("END:VCALENDAR");
    expect(lines).not.toContain("BEGIN:VEVENT");
  });

  it("uses CRLF line endings", () => {
    const ics = buildResetCalendar([job()], { now: NOW });
    expect(ics.includes("\r\n")).toBe(true);
    // No bare LF that isn't part of a CRLF.
    expect(/[^\r]\n/.test(ics)).toBe(false);
  });

  it("emits one VEVENT per waiting job with the reset as DTSTART", () => {
    const ics = buildResetCalendar([job({ id: "abc", resetAt: "2026-07-13T05:00:00.000Z" })], { now: NOW });
    const lines = unfold(ics);
    expect(lines).toContain("BEGIN:VEVENT");
    expect(lines).toContain("UID:abc@agentrelay");
    expect(lines).toContain("DTSTART:20260713T050000Z");
    expect(lines).toContain("DTSTAMP:20260730T100000Z");
    expect(lines).toContain("SUMMARY:AgentRelay: resume alpha");
  });

  it("includes a display VALARM by default and omits it when disabled", () => {
    const withAlarm = unfold(buildResetCalendar([job()], { now: NOW }));
    expect(withAlarm).toContain("BEGIN:VALARM");
    expect(withAlarm).toContain("TRIGGER:PT0M");

    const noAlarm = unfold(buildResetCalendar([job()], { now: NOW, withAlarm: false }));
    expect(noAlarm).not.toContain("BEGIN:VALARM");
  });

  it("escapes special characters in project/command text", () => {
    const ics = buildResetCalendar([job({ project: "a;b,c", command: ["claude", "-p", "do; this, now"] })], {
      now: NOW,
    });
    const lines = unfold(ics);
    expect(lines).toContain("SUMMARY:AgentRelay: resume a\\;b\\,c");
    expect(lines.some((l) => l.startsWith("DESCRIPTION:") && l.includes("do\\; this\\, now"))).toBe(true);
  });

  it("has balanced BEGIN/END blocks", () => {
    const ics = buildResetCalendar([job(), job(), job()], { now: NOW });
    const lines = unfold(ics);
    const count = (needle: string) => lines.filter((l) => l === needle).length;
    expect(count("BEGIN:VEVENT")).toBe(3);
    expect(count("END:VEVENT")).toBe(3);
    expect(count("BEGIN:VALARM")).toBe(3);
    expect(count("END:VALARM")).toBe(3);
    expect(count("BEGIN:VCALENDAR")).toBe(1);
    expect(count("END:VCALENDAR")).toBe(1);
  });

  it("is deterministic for a fixed now and job set", () => {
    const jobs = [job({ id: "j1", resetAt: "2026-07-30T13:00:00.000Z" })];
    expect(buildResetCalendar(jobs, { now: NOW })).toBe(buildResetCalendar(jobs, { now: NOW }));
  });
});
