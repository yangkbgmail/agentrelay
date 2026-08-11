import { describe, expect, it } from "vitest";
import { escapeIcsText, foldIcsLine, formatIcsUtc, jobsToIcs } from "./calendar.js";
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

const NOW = Date.parse("2026-07-30T10:00:00.000Z");

describe("formatIcsUtc", () => {
  it("formats an instant as a compact UTC date-time", () => {
    expect(formatIcsUtc(Date.parse("2026-07-30T12:34:56.000Z"))).toBe("20260730T123456Z");
  });

  it("zero-pads single-digit month/day/time components", () => {
    expect(formatIcsUtc(Date.parse("2026-01-02T03:04:05.000Z"))).toBe("20260102T030405Z");
  });
});

describe("escapeIcsText", () => {
  it("escapes backslash, semicolon, comma and newlines", () => {
    expect(escapeIcsText("a\\b;c,d\ne")).toBe("a\\\\b\\;c\\,d\\ne");
  });

  it("collapses CRLF and CR to a single literal \\n", () => {
    expect(escapeIcsText("x\r\ny\rz")).toBe("x\\ny\\nz");
  });

  it("leaves plain text untouched", () => {
    expect(escapeIcsText("hello world")).toBe("hello world");
  });
});

describe("foldIcsLine", () => {
  it("leaves a short line unfolded", () => {
    expect(foldIcsLine("SUMMARY:hi")).toBe("SUMMARY:hi");
  });

  it("folds a long line at 75 octets with CRLF + space continuation", () => {
    const line = `X:${"a".repeat(120)}`;
    const folded = foldIcsLine(line);
    const parts = folded.split("\r\n ");
    expect(parts.length).toBeGreaterThan(1);
    // First physical line is at most 75 octets; continuations start with a space.
    expect(Buffer.byteLength(parts[0], "utf8")).toBeLessThanOrEqual(75);
    // Rejoining (dropping the fold's leading space) reconstructs the original.
    expect(parts.join("")).toBe(line);
  });

  it("never splits a multi-byte code point across a fold", () => {
    // 40 emoji (4 UTF-8 octets each) = 160 octets, forcing folds.
    const line = `X:${"😀".repeat(40)}`;
    const folded = foldIcsLine(line);
    // No fold boundary should land mid-sequence: every physical line decodes cleanly.
    for (const part of folded.split("\r\n ")) {
      expect(Buffer.byteLength(part, "utf8")).toBeLessThanOrEqual(75);
      // A cleanly-split UTF-8 string round-trips through a Buffer unchanged.
      expect(Buffer.from(part, "utf8").toString("utf8")).toBe(part);
    }
  });
});

describe("jobsToIcs", () => {
  it("emits a valid, event-less VCALENDAR for an empty queue", () => {
    const { ics, eventCount } = jobsToIcs([], { now: NOW });
    expect(eventCount).toBe(0);
    expect(ics).toContain("BEGIN:VCALENDAR\r\n");
    expect(ics).toContain("VERSION:2.0");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  it("emits one VEVENT per waiting job, timed at its reset", () => {
    const { ics, eventCount } = jobsToIcs([job({ resetAt: "2026-07-30T15:00:00.000Z" })], { now: NOW });
    expect(eventCount).toBe(1);
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("DTSTART:20260730T150000Z");
    // Default 15-minute duration.
    expect(ics).toContain("DTEND:20260730T151500Z");
    expect(ics).toContain("UID:job-");
    expect(ics).toContain("@agentrelay");
    expect(ics).toContain("DTSTAMP:20260730T100000Z");
    expect(ics).toContain("SUMMARY:AgentRelay resume: alpha");
    expect(ics).toContain("STATUS:CONFIRMED");
  });

  it("only includes waiting_for_reset jobs with a parseable resetAt", () => {
    const { ics, eventCount } = jobsToIcs(
      [
        job({ status: "completed", resetAt: "2026-07-30T20:00:00.000Z" }),
        job({ status: "queued", resetAt: null }),
        job({ status: "waiting_for_reset", resetAt: "not-a-date" }),
        job({ status: "waiting_for_reset", resetAt: "2026-07-30T13:00:00.000Z" }),
      ],
      { now: NOW }
    );
    expect(eventCount).toBe(1);
    expect(ics).toContain("DTSTART:20260730T130000Z");
  });

  it("orders events soonest-reset first (matching upcoming/next)", () => {
    const { ics } = jobsToIcs(
      [
        job({ id: "late", resetAt: "2026-07-30T18:00:00.000Z" }),
        job({ id: "soon", resetAt: "2026-07-30T13:00:00.000Z" }),
      ],
      { now: NOW }
    );
    expect(ics.indexOf("UID:soon@")).toBeLessThan(ics.indexOf("UID:late@"));
  });

  it("honors a custom duration and calendar name", () => {
    const { ics } = jobsToIcs([job({ resetAt: "2026-07-30T15:00:00.000Z" })], {
      now: NOW,
      durationMinutes: 60,
      calendarName: "My resumes",
    });
    expect(ics).toContain("DTEND:20260730T160000Z");
    expect(ics).toContain("X-WR-CALNAME:My resumes");
  });

  it("falls back to the default duration for non-positive/invalid values", () => {
    const { ics } = jobsToIcs([job({ resetAt: "2026-07-30T15:00:00.000Z" })], {
      now: NOW,
      durationMinutes: 0,
    });
    expect(ics).toContain("DTEND:20260730T151500Z");
  });

  it("escapes special characters in the project name and command", () => {
    const { ics } = jobsToIcs([job({ project: "a;b,c", command: ["claude", "-p", "fix; then, ship"] })], { now: NOW });
    expect(ics).toContain("SUMMARY:AgentRelay resume: a\\;b\\,c");
    expect(ics).toContain("fix\\; then\\, ship");
  });

  it("uses CRLF line endings throughout", () => {
    const { ics } = jobsToIcs([job()], { now: NOW });
    // Every line break is a CRLF: there are no bare LFs that aren't preceded by CR.
    expect(/[^\r]\n/.test(ics)).toBe(false);
  });
});
