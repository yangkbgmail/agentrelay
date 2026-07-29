import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayQueue } from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readHealthReport, writeDaemonHeartbeat } from "../src/commands.js";
import { renderHealth, renderHealthJson } from "../src/health.js";

const AT = "2026-07-25T12:00:00.000Z";
const NOW = Date.parse(AT);

describe("readHealthReport (fs + clock half)", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-health-test-"));
    storePath = join(dir, "jobs.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Queue one active (waiting) job so the "jobs waiting" logic engages. */
  function seedActiveJob(): void {
    const queue = new RelayQueue(storePath);
    queue.enqueue({ project: "p", tool: "claude-code", command: ["node", "--version"], cwd: dir });
    queue.close();
  }

  /** Write a fresh (alive) daemon heartbeat ticked `agoMs` before NOW. */
  function seedHeartbeat(agoMs: number, pollIntervalMs = 30_000): void {
    writeDaemonHeartbeat(storePath, {
      pid: 4242,
      mode: "daemon",
      startedAt: AT,
      lastTickAt: new Date(NOW - agoMs).toISOString(),
      pollIntervalMs,
    });
  }

  it("no heartbeat + nothing waiting → idle, exit 0", () => {
    const report = readHealthReport({ storePath, nowMs: NOW });
    expect(report.level).toBe("idle");
    expect(report.exitCode).toBe(0);
    expect(report.heartbeat.state).toBe("absent");
  });

  it("no heartbeat + a job waiting → unhealthy, exit 1", () => {
    seedActiveJob();
    const report = readHealthReport({ storePath, nowMs: NOW });
    expect(report.level).toBe("unhealthy");
    expect(report.exitCode).toBe(1);
    expect(report.heartbeat.waitingJobs).toBe(1);
    expect(report.reason).toContain("1 job(s) waiting");
  });

  it("fresh heartbeat + a job waiting → healthy, exit 0", () => {
    seedActiveJob();
    seedHeartbeat(5_000);
    const report = readHealthReport({ storePath, nowMs: NOW });
    expect(report.level).toBe("healthy");
    expect(report.exitCode).toBe(0);
    expect(report.heartbeat.state).toBe("alive");
  });

  it("stale heartbeat + a job waiting → unhealthy, exit 1", () => {
    seedActiveJob();
    seedHeartbeat(10 * 60_000); // 10 min ago, past the 90s daemon stale window
    const report = readHealthReport({ storePath, nowMs: NOW });
    expect(report.level).toBe("unhealthy");
    expect(report.exitCode).toBe(1);
    expect(report.heartbeat.state).toBe("stale");
  });

  it("stale heartbeat + nothing waiting → idle by default, unhealthy under strict", () => {
    seedHeartbeat(10 * 60_000);
    expect(readHealthReport({ storePath, nowMs: NOW }).level).toBe("idle");
    expect(readHealthReport({ storePath, nowMs: NOW, strict: true }).level).toBe("unhealthy");
  });

  it("garbled heartbeat file reads as absent (never throws)", () => {
    writeDaemonHeartbeat(storePath, {
      pid: 1,
      mode: "daemon",
      startedAt: AT,
      lastTickAt: AT,
      pollIntervalMs: 30_000,
    });
    // Corrupt it after the fact.
    rmSync(join(dir, "daemon.json"));
    const report = readHealthReport({ storePath, nowMs: NOW });
    expect(report.heartbeat.state).toBe("absent");
    expect(report.level).toBe("idle");
  });
});

describe("renderHealth", () => {
  const base = {
    exitCode: 0,
    reason: "resume loop alive",
    heartbeat: {
      state: "alive" as const,
      mode: "daemon" as const,
      pid: 4242,
      lastTickAt: AT,
      ageMs: 5_000,
      staleAfterMs: 90_000,
      waitingJobs: 0,
      concerning: false,
    },
  };

  it("shows the verdict word, reason, and heartbeat detail", () => {
    const line = renderHealth({ ...base, level: "healthy" });
    expect(line).toContain("HEALTHY");
    expect(line).toContain("resume loop alive");
    expect(line).toContain("daemon");
    expect(line).toContain("pid 4242");
    expect(line).toContain("last tick 5s ago");
  });

  it("has no ANSI codes when color is off, and codes when on", () => {
    const plain = renderHealth({ ...base, level: "unhealthy", reason: "x" });
    expect(plain).not.toContain("\x1b[");
    const colored = renderHealth({ ...base, level: "unhealthy", reason: "x" }, { color: true });
    expect(colored).toContain("\x1b[");
  });

  it("omits the detail suffix when no heartbeat is present (absent loop)", () => {
    const line = renderHealth({
      level: "idle",
      exitCode: 0,
      reason: "resume loop absent, nothing waiting",
      heartbeat: { state: "absent", waitingJobs: 0, concerning: false },
    });
    expect(line).toContain("IDLE");
    expect(line).not.toContain("(");
  });

  it("renderHealthJson round-trips the report plus store + timestamp", () => {
    const json = JSON.parse(renderHealthJson({ ...base, level: "healthy" }, "/tmp/jobs.json", AT));
    expect(json.level).toBe("healthy");
    expect(json.exitCode).toBe(0);
    expect(json.store).toBe("/tmp/jobs.json");
    expect(json.generatedAt).toBe(AT);
    expect(json.heartbeat.state).toBe("alive");
  });
});
