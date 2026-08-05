import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayQueue } from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportIcal } from "../src/commands.js";

const NOW = Date.parse("2026-07-30T10:00:00.000Z");

describe("exportIcal", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-ical-test-"));
    storePath = join(dir, "jobs.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Seed one waiting job (with a reset) and one completed job (never scheduled). */
  function seed(): void {
    const queue = new RelayQueue(storePath);
    const waiting = queue.enqueue({
      project: "alpha",
      tool: "claude-code",
      command: ["claude", "-p", "go"],
      cwd: "/a",
    });
    queue.markWaitingForReset(waiting.id, "2026-07-30T13:00:00.000Z");
    const done = queue.enqueue({ project: "beta", tool: "codex-cli", command: ["codex", "run"], cwd: "/b" });
    queue.markResuming(done.id);
    queue.markCompleted(done.id);
    queue.close();
  }

  it("counts only schedulable jobs, not the whole store", () => {
    seed();
    const result = exportIcal({ storePath, ical: { now: NOW } });
    expect(result.count).toBe(1); // the completed job is not a resume event
    expect(result.writtenTo).toBeNull();
    expect(result.content).toContain("BEGIN:VCALENDAR");
    expect(result.content).toContain("SUMMARY:Resume claude-code: alpha");
    expect(result.content).not.toContain("codex");
  });

  it("writes a .ics file with a trailing newline when outPath is set", () => {
    seed();
    const out = join(dir, "resumes.ics");
    const result = exportIcal({ storePath, outPath: out, ical: { now: NOW } });
    expect(result.writtenTo).toBe(out);
    const written = readFileSync(out, "utf8");
    expect(written.endsWith("\n")).toBe(true);
    expect(written).toContain("BEGIN:VCALENDAR");
    expect(written).toContain("DTSTART:20260730T130000Z");
  });

  it("serializes only the jobs it is given", () => {
    seed();
    const result = exportIcal({ storePath, jobs: [], ical: { now: NOW } });
    expect(result.count).toBe(0);
    expect(result.content).not.toContain("BEGIN:VEVENT");
  });

  it("emits a valid empty calendar for an empty store", () => {
    const result = exportIcal({ storePath, ical: { now: NOW } });
    expect(result.count).toBe(0);
    expect(result.content).toContain("BEGIN:VCALENDAR");
    expect(result.content).toContain("END:VCALENDAR");
    expect(result.content).not.toContain("BEGIN:VEVENT");
  });
});
