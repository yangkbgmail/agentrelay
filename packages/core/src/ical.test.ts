import { describe, expect, it } from "vitest";
import { escapeIcalText, foldIcalLine, formatIcalDate, jobsToIcal, selectSchedulableJobs } from "./ical.js";
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

/** Unfold folded lines and split a VCALENDAR string into logical lines. */
function logicalLines(ics: string): string[] {
  return ics.replace(/\r\n /g, "").split("\r\n");
}

describe("formatIcalDate", () => {
  it("renders epoch ms as an RFC 5545 UTC date-time", () => {
    expect(formatIcalDate(Date.parse("2026-07-30T12:34:56.000Z"))).toBe("20260730T123456Z");
  });

  it("zero-pads every field", () => {
    expect(formatIcalDate(Date.parse("2026-01-02T03:04:05.000Z"))).toBe("20260102T030405Z");
  });
});

describe("escapeIcalText", () => {
  it("escapes backslash, semicolon, comma and newlines", () => {
    expect(escapeIcalText("a\\b;c,d\ne")).toBe("a\\\\b\\;c\\,d\\ne");
  });

  it("leaves colons untouched", () => {
    expect(escapeIcalText("Command: claude -p go")).toBe("Command: claude -p go");
  });
});

describe("foldIcalLine", () => {
  it("leaves short lines untouched", () => {
    expect(foldIcalLine("SUMMARY:hello")).toBe("SUMMARY:hello");
  });

  it("folds long lines with CRLF + a leading space and never exceeds 75 octets per line", () => {
    const long = `DESCRIPTION:${"x".repeat(200)}`;
    const folded = foldIcalLine(long);
    expect(folded).toContain("\r\n ");
    for (const physical of folded.split("\r\n")) {
      expect(Buffer.byteLength(physical, "utf8")).toBeLessThanOrEqual(75);
    }
    // Unfolding restores the original content exactly.
    expect(folded.replace(/\r\n /g, "")).toBe(long);
  });

  it("never splits a multi-byte character across a fold boundary", () => {
    const long = `SUMMARY:${"가".repeat(60)}`; // 3 bytes each
    const folded = foldIcalLine(long);
    for (const physical of folded.split("\r\n")) {
      // A split mid-character would make this physical line invalid UTF-8;
      // round-tripping through Buffer proves each piece is whole.
      expect(Buffer.from(physical, "utf8").toString("utf8")).toBe(physical);
    }
    expect(folded.replace(/\r\n /g, "")).toBe(long);
  });
});

describe("selectSchedulableJobs", () => {
  it("keeps only waiting_for_reset jobs with a parseable resetAt", () => {
    const picked = selectSchedulableJobs([
      job({ id: "completed", status: "completed" }),
      job({ id: "queued", status: "queued" }),
      job({ id: "no-reset", resetAt: null }),
      job({ id: "bad-reset", resetAt: "not a date" }),
      job({ id: "good", resetAt: "2026-07-30T13:00:00.000Z" }),
    ]);
    expect(picked.map((j) => j.id)).toEqual(["good"]);
  });

  it("orders by soonest reset, then createdAt, then id", () => {
    const picked = selectSchedulableJobs([
      job({ id: "later", resetAt: "2026-07-30T15:00:00.000Z" }),
      job({ id: "tie-b", resetAt: "2026-07-30T13:00:00.000Z", createdAt: "2026-07-30T02:00:00.000Z" }),
      job({ id: "tie-a", resetAt: "2026-07-30T13:00:00.000Z", createdAt: "2026-07-30T01:00:00.000Z" }),
    ]);
    expect(picked.map((j) => j.id)).toEqual(["tie-a", "tie-b", "later"]);
  });

  it("does not mutate the input array", () => {
    const input = [job({ id: "b", resetAt: "2026-07-30T15:00:00.000Z" }), job({ id: "a" })];
    const before = input.map((j) => j.id);
    selectSchedulableJobs(input);
    expect(input.map((j) => j.id)).toEqual(before);
  });
});

describe("jobsToIcal", () => {
  it("emits a valid empty VCALENDAR when nothing is waiting", () => {
    const ics = jobsToIcal([], { now: NOW });
    const lines = logicalLines(ics);
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines).toContain("VERSION:2.0");
    expect(lines[lines.length - 1]).toBe("END:VCALENDAR");
    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  it("uses CRLF line endings", () => {
    const ics = jobsToIcal([job()], { now: NOW });
    expect(ics).toContain("\r\n");
    expect(ics.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("emits one VEVENT per schedulable job with the expected properties", () => {
    const ics = jobsToIcal(
      [
        job({ id: "j1", project: "web", tool: "codex-cli", resetAt: "2026-07-30T13:00:00.000Z", cwd: "/home/me/web" }),
        job({ id: "skip", status: "completed" }),
      ],
      { now: NOW }
    );
    const lines = logicalLines(ics);
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
    expect(lines).toContain("UID:j1@agentrelay");
    expect(lines).toContain("DTSTAMP:20260730T100000Z");
    expect(lines).toContain("DTSTART:20260730T130000Z");
    expect(lines).toContain("DURATION:PT5M");
    expect(lines).toContain("SUMMARY:Resume codex-cli: web");
    expect(lines).toContain("LOCATION:/home/me/web");
  });

  it("orders events by resume time", () => {
    const ics = jobsToIcal(
      [
        job({ id: "second", resetAt: "2026-07-30T15:00:00.000Z" }),
        job({ id: "first", resetAt: "2026-07-30T13:00:00.000Z" }),
      ],
      { now: NOW }
    );
    const uids = logicalLines(ics).filter((l) => l.startsWith("UID:"));
    expect(uids).toEqual(["UID:first@agentrelay", "UID:second@agentrelay"]);
  });

  it("escapes special characters in text fields", () => {
    const ics = jobsToIcal([job({ id: "x", project: "a,b;c", command: ["claude", "-p", "do; this, now"] })], {
      now: NOW,
    });
    const lines = logicalLines(ics);
    expect(lines).toContain("SUMMARY:Resume claude-code: a\\,b\\;c");
    expect(lines.some((l) => l.startsWith("DESCRIPTION:") && l.includes("do\\; this\\, now"))).toBe(true);
  });

  it("omits DURATION when durationMs is zero or negative", () => {
    const ics = jobsToIcal([job()], { now: NOW, durationMs: 0 });
    expect(ics).not.toContain("DURATION:");
  });

  it("honors a custom calendar name and prodId", () => {
    const ics = jobsToIcal([], { now: NOW, calName: "my resumes", prodId: "-//acme//x//EN" });
    const lines = logicalLines(ics);
    expect(lines).toContain("X-WR-CALNAME:my resumes");
    expect(lines).toContain("PRODID:-//acme//x//EN");
  });
});
