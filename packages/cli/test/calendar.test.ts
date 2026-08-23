import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayQueue } from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportCalendar, listStatus } from "../src/commands.js";

describe("exportCalendar", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-calendar-test-"));
    storePath = join(dir, "jobs.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Seed: one waiting job (charted), one completed job (ignored). */
  function seed(): void {
    const queue = new RelayQueue(storePath);
    const waiting = queue.enqueue({
      project: "alpha",
      tool: "claude-code",
      command: ["claude", "-p", "go"],
      cwd: "/a",
    });
    queue.markWaitingForReset(waiting.id, "2026-08-24T05:00:00.000Z");
    const done = queue.enqueue({ project: "beta", tool: "codex-cli", command: ["codex", "run"], cwd: "/b" });
    queue.markCompleted(done.id);
    queue.close();
  }

  const FIXED_NOW = new Date("2026-08-23T00:00:00.000Z");

  it("charts only waiting_for_reset jobs and reports the count", () => {
    seed();
    const result = exportCalendar({ storePath, calendar: { now: FIXED_NOW } });
    expect(result.count).toBe(1);
    expect(result.writtenTo).toBeNull();
    expect(result.content).toContain("BEGIN:VCALENDAR");
    expect(result.content).toContain("SUMMARY:AgentRelay: resume alpha");
    expect(result.content).not.toContain("resume beta");
    // Exactly one event for the single waiting job.
    expect(result.content.match(/BEGIN:VEVENT/g) ?? []).toHaveLength(1);
  });

  it("writes an .ics file (CRLF-terminated) when outPath is given", () => {
    seed();
    const outPath = join(dir, "resumes.ics");
    const result = exportCalendar({ storePath, outPath, calendar: { now: FIXED_NOW } });
    expect(result.writtenTo).toBe(outPath);
    const written = readFileSync(outPath, "utf8");
    expect(written.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(written.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("honors withAlarm: false", () => {
    seed();
    const result = exportCalendar({ storePath, calendar: { now: FIXED_NOW, withAlarm: false } });
    expect(result.content).not.toContain("BEGIN:VALARM");
  });

  it("serializes only the jobs it is given", () => {
    seed();
    const waitingOnly = listStatus(storePath).filter((j) => j.status === "waiting_for_reset");
    const result = exportCalendar({ storePath, jobs: waitingOnly, calendar: { now: FIXED_NOW } });
    expect(result.count).toBe(1);
  });

  it("produces an empty (event-free) calendar when nothing is waiting", () => {
    const queue = new RelayQueue(storePath);
    queue.enqueue({ project: "alpha", tool: "claude-code", command: ["claude"], cwd: "/a" });
    queue.close();
    const result = exportCalendar({ storePath, calendar: { now: FIXED_NOW } });
    expect(result.count).toBe(0);
    expect(result.content).toContain("BEGIN:VCALENDAR");
    expect(result.content).not.toContain("BEGIN:VEVENT");
  });
});
