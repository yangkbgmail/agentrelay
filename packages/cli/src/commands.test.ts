import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonHeartbeatPath, serializeDaemonHeartbeat } from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startDaemon } from "./commands.js";

describe("startDaemon single-instance guard", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-daemon-"));
    storePath = join(dir, "jobs.json");
    process.exitCode = 0;
  });

  afterEach(() => {
    process.exitCode = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  function writeDaemonBeat(pollIntervalMs = 30_000): void {
    const at = new Date().toISOString();
    writeFileSync(
      daemonHeartbeatPath(storePath),
      serializeDaemonHeartbeat({ pid: 999_999, mode: "daemon", startedAt: at, lastTickAt: at, pollIntervalMs }),
      "utf8"
    );
  }

  it("refuses to start when a live daemon already watches the store", () => {
    writeDaemonBeat();
    const scheduler = startDaemon({ storePath, isProcessAlive: () => true });
    expect(scheduler).toBeNull();
    expect(process.exitCode).toBe(1);
  });

  it("starts anyway with force, even against a live daemon", () => {
    writeDaemonBeat();
    const scheduler = startDaemon({ storePath, force: true, isProcessAlive: () => true });
    expect(scheduler).not.toBeNull();
    expect(process.exitCode).toBe(0);
    scheduler?.stop();
  });

  it("starts when the recorded daemon pid is dead (ghost heartbeat)", () => {
    writeDaemonBeat();
    const scheduler = startDaemon({ storePath, isProcessAlive: () => false });
    expect(scheduler).not.toBeNull();
    expect(process.exitCode).toBe(0);
    scheduler?.stop();
  });
});
