import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayJob } from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeCalendar } from "../src/commands.js";

const NOW = Date.parse("2026-08-11T10:00:00.000Z");

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
    resetAt: "2026-08-11T15:00:00.000Z",
    createdAt: "2026-08-11T09:00:00.000Z",
    updatedAt: "2026-08-11T09:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("writeCalendar", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-calendar-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("renders the given waiting jobs to stdout (no file) by default", () => {
    const result = writeCalendar({ jobs: [job()], calendar: { now: NOW } });
    expect(result.writtenTo).toBeNull();
    expect(result.eventCount).toBe(1);
    expect(result.content).toContain("BEGIN:VCALENDAR");
    expect(result.content).toContain("DTSTART:20260811T150000Z");
  });

  it("only counts waiting_for_reset jobs with a parseable reset", () => {
    const result = writeCalendar({
      jobs: [
        job({ status: "completed", resetAt: "2026-08-11T20:00:00.000Z" }),
        job({ status: "waiting_for_reset", resetAt: null }),
        job({ status: "waiting_for_reset", resetAt: "2026-08-11T16:00:00.000Z" }),
      ],
      calendar: { now: NOW },
    });
    expect(result.eventCount).toBe(1);
    expect(result.content).toContain("DTSTART:20260811T160000Z");
  });

  it("writes a byte-exact .ics file (already CRLF-terminated) when outPath is given", () => {
    const out = join(dir, "nested", "resumes.ics");
    const result = writeCalendar({ jobs: [job()], outPath: out, calendar: { now: NOW } });
    expect(result.writtenTo).toBe(out);
    const onDisk = readFileSync(out, "utf8");
    // The file content equals the serializer output exactly — no trailing-newline fixup.
    expect(onDisk).toBe(result.content);
    expect(onDisk.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("forwards duration and calendar name to jobsToIcs", () => {
    const result = writeCalendar({
      jobs: [job()],
      calendar: { now: NOW, durationMinutes: 45, calendarName: "Team resumes" },
    });
    expect(result.content).toContain("DTEND:20260811T154500Z");
    expect(result.content).toContain("X-WR-CALNAME:Team resumes");
  });

  it("emits a valid, event-less calendar for an empty job set", () => {
    const result = writeCalendar({ jobs: [], calendar: { now: NOW } });
    expect(result.eventCount).toBe(0);
    expect(result.content).toContain("BEGIN:VCALENDAR");
    expect(result.content).not.toContain("BEGIN:VEVENT");
  });
});
