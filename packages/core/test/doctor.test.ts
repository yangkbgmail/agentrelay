import { describe, expect, it } from "vitest";
import type { ConfigIssue } from "../src/config.js";
import {
  countActiveJobs,
  type DiagnosticInput,
  distinctActiveBinaries,
  farFutureResets,
  isSupportedNode,
  parseNodeVersion,
  runDiagnostics,
} from "../src/doctor.js";
import type { RelayJob } from "../src/types.js";

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `job${seq}`,
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status: "completed",
    resetAt: null,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function input(overrides: Partial<DiagnosticInput> = {}): DiagnosticInput {
  return {
    nodeVersion: "v22.5.0",
    store: { path: "/home/u/.agentrelay/jobs.json", exists: true, corrupt: false, jobCount: 0, activeCount: 0 },
    writable: { dir: "/home/u/.agentrelay", writable: true, willCreate: false },
    config: { path: null, loadError: null, issues: [] },
    notify: { slackWebhook: "https://hooks.slack.com/x" },
    adapters: { binaries: [] },
    heartbeat: { present: false },
    resetHorizon: { maxFutureMs: 8 * 24 * 60 * 60_000, farFuture: [] },
    ...overrides,
  };
}

const find = (report: ReturnType<typeof runDiagnostics>, name: string) => report.checks.find((c) => c.name === name)!;

describe("parseNodeVersion", () => {
  it("parses a v-prefixed version", () => {
    expect(parseNodeVersion("v22.5.0")).toEqual({ major: 22, minor: 5 });
  });
  it("parses a bare major.minor", () => {
    expect(parseNodeVersion("24.1")).toEqual({ major: 24, minor: 1 });
  });
  it("tolerates pre-release/build noise", () => {
    expect(parseNodeVersion("v23.0.0-nightly")).toEqual({ major: 23, minor: 0 });
  });
  it("returns null on garbage", () => {
    expect(parseNodeVersion("not-a-version")).toBeNull();
  });
});

describe("isSupportedNode", () => {
  it("accepts the exact floor", () => {
    expect(isSupportedNode("v22.5.0")).toBe(true);
  });
  it("accepts a newer minor", () => {
    expect(isSupportedNode("v22.9.1")).toBe(true);
  });
  it("accepts a newer major", () => {
    expect(isSupportedNode("v24.0.0")).toBe(true);
  });
  it("rejects an older minor on the floor major", () => {
    expect(isSupportedNode("v22.4.0")).toBe(false);
  });
  it("rejects an older major", () => {
    expect(isSupportedNode("v20.11.0")).toBe(false);
  });
  it("rejects an unparseable version", () => {
    expect(isSupportedNode("weird")).toBe(false);
  });
});

describe("countActiveJobs", () => {
  it("counts only non-terminal jobs", () => {
    const jobs = [
      job({ status: "queued" }),
      job({ status: "waiting_for_reset" }),
      job({ status: "resuming" }),
      job({ status: "completed" }),
      job({ status: "failed" }),
      job({ status: "cancelled" }),
    ];
    expect(countActiveJobs(jobs)).toBe(3);
  });
  it("is zero for an empty store", () => {
    expect(countActiveJobs([])).toBe(0);
  });
});

describe("runDiagnostics", () => {
  it("reports all-healthy when everything is fine", () => {
    const report = runDiagnostics(input());
    expect(report.ok).toBe(true);
    expect(report.counts.error).toBe(0);
    expect(find(report, "node-version").level).toBe("ok");
    expect(find(report, "store").level).toBe("ok");
    expect(find(report, "store-writable").level).toBe("ok");
    expect(find(report, "adapters").level).toBe("ok");
    expect(find(report, "config").level).toBe("ok");
    expect(find(report, "notify").level).toBe("ok");
  });

  it("fails on an unsupported Node version", () => {
    const report = runDiagnostics(input({ nodeVersion: "v20.10.0" }));
    const node = find(report, "node-version");
    expect(node.level).toBe("error");
    expect(node.hint).toContain("22.5");
    expect(report.ok).toBe(false);
  });

  it("warns (not errors) on an unparseable Node version", () => {
    const report = runDiagnostics(input({ nodeVersion: "custom-build" }));
    expect(find(report, "node-version").level).toBe("warning");
    expect(report.ok).toBe(true);
  });

  it("errors on a corrupt store", () => {
    const report = runDiagnostics(
      input({ store: { path: "/s/jobs.json", exists: true, corrupt: true, jobCount: 0, activeCount: 0 } })
    );
    const store = find(report, "store");
    expect(store.level).toBe("error");
    expect(store.hint).toContain("restore");
    expect(report.ok).toBe(false);
  });

  it("treats an absent store as OK (first run)", () => {
    const report = runDiagnostics(
      input({ store: { path: "/s/jobs.json", exists: false, corrupt: false, jobCount: 0, activeCount: 0 } })
    );
    const store = find(report, "store");
    expect(store.level).toBe("ok");
    expect(store.message).toContain("created on first run");
  });

  it("mentions the active job count when there are active jobs", () => {
    const report = runDiagnostics(
      input({ store: { path: "/s/jobs.json", exists: true, corrupt: false, jobCount: 5, activeCount: 2 } })
    );
    expect(find(report, "store").message).toContain("2 active");
  });

  it("errors when the config file could not be loaded", () => {
    const report = runDiagnostics(input({ config: { path: "/c.json", loadError: "Invalid JSON", issues: [] } }));
    const config = find(report, "config");
    expect(config.level).toBe("error");
    expect(config.message).toContain("Invalid JSON");
    expect(report.ok).toBe(false);
  });

  it("errors when config has error-level issues", () => {
    const issues: ConfigIssue[] = [{ level: "error", path: "retry.factor", message: "must be at least 1" }];
    const report = runDiagnostics(input({ config: { path: "/c.json", loadError: null, issues } }));
    const config = find(report, "config");
    expect(config.level).toBe("error");
    expect(config.message).toContain("retry.factor");
  });

  it("warns when config has only warning-level issues", () => {
    const issues: ConfigIssue[] = [{ level: "warning", path: "store", message: "is empty" }];
    const report = runDiagnostics(input({ config: { path: "/c.json", loadError: null, issues } }));
    const config = find(report, "config");
    expect(config.level).toBe("warning");
    expect(report.ok).toBe(true);
  });

  it("treats no config file as OK", () => {
    const report = runDiagnostics(input({ config: { path: null, loadError: null, issues: [] } }));
    expect(find(report, "config").level).toBe("ok");
  });

  it("warns when no notification channel is configured", () => {
    const report = runDiagnostics(input({ notify: {} }));
    const notify = find(report, "notify");
    expect(notify.level).toBe("warning");
    expect(report.ok).toBe(true);
  });

  it("ignores whitespace-only notify values", () => {
    const report = runDiagnostics(input({ notify: { slackWebhook: "   ", webhookUrl: "" } }));
    expect(find(report, "notify").level).toBe("warning");
  });

  it("lists both channels when both are set", () => {
    const report = runDiagnostics(input({ notify: { slackWebhook: "https://s", webhookUrl: "https://w" } }));
    const notify = find(report, "notify");
    expect(notify.level).toBe("ok");
    expect(notify.message).toContain("Slack + webhook");
  });

  it("reports adapters OK (nothing to check) when no job is queued", () => {
    const report = runDiagnostics(input({ adapters: { binaries: [] } }));
    const adapters = find(report, "adapters");
    expect(adapters.level).toBe("ok");
    expect(adapters.message).toContain("no queued jobs");
  });

  it("reports adapters OK and lists resolved paths when every binary is on PATH", () => {
    const report = runDiagnostics(
      input({
        adapters: { binaries: [{ binary: "claude", found: true, resolvedPath: "/usr/bin/claude", neededBy: 2 }] },
      })
    );
    const adapters = find(report, "adapters");
    expect(adapters.level).toBe("ok");
    expect(adapters.message).toContain("claude (/usr/bin/claude)");
    expect(report.ok).toBe(true);
  });

  it("errors when a queued job's binary is missing from PATH", () => {
    const report = runDiagnostics(
      input({
        adapters: {
          binaries: [
            { binary: "claude", found: true, resolvedPath: "/usr/bin/claude", neededBy: 1 },
            { binary: "codex", found: false, neededBy: 1 },
          ],
        },
      })
    );
    const adapters = find(report, "adapters");
    expect(adapters.level).toBe("error");
    expect(adapters.message).toContain("1 of 2");
    expect(adapters.message).toContain("codex");
    expect(adapters.hint).toContain("which codex");
    expect(report.ok).toBe(false);
  });

  it("counts levels and computes ok across all checks", () => {
    const report = runDiagnostics(input({ nodeVersion: "v20.0.0", notify: {} }));
    expect(report.counts.error).toBe(1); // node
    expect(report.counts.warning).toBe(1); // notify
    expect(report.counts.ok).toBe(6); // store + store-writable + adapters + daemon + reset-horizon + config
    expect(report.ok).toBe(false);
  });

  it("reports store-writable OK for a writable directory", () => {
    const report = runDiagnostics(input());
    const writable = find(report, "store-writable");
    expect(writable.level).toBe("ok");
    expect(writable.message).toContain("is writable");
  });

  it("notes that the store directory will be created on first run", () => {
    const report = runDiagnostics(
      input({ writable: { dir: "/home/u/.agentrelay", writable: true, willCreate: true } })
    );
    const writable = find(report, "store-writable");
    expect(writable.level).toBe("ok");
    expect(writable.message).toContain("will be created");
  });

  it("errors when the store directory is not writable, surfacing the OS error", () => {
    const report = runDiagnostics(
      input({
        writable: {
          dir: "/readonly/.agentrelay",
          writable: false,
          willCreate: false,
          error: "EACCES: permission denied",
        },
      })
    );
    const writable = find(report, "store-writable");
    expect(writable.level).toBe("error");
    expect(writable.message).toContain("/readonly/.agentrelay");
    expect(writable.message).toContain("EACCES: permission denied");
    expect(writable.hint).toContain("AGENTRELAY_STORE");
    expect(report.ok).toBe(false);
  });

  describe("daemon (resume-loop liveness) check", () => {
    const store = (activeCount: number): DiagnosticInput["store"] => ({
      path: "/home/u/.agentrelay/jobs.json",
      exists: true,
      corrupt: false,
      jobCount: Math.max(activeCount, 1),
      activeCount,
    });

    it("is OK when no loop is running and nothing is waiting", () => {
      const report = runDiagnostics(input({ heartbeat: { present: false }, store: store(0) }));
      const daemon = find(report, "daemon");
      expect(daemon.level).toBe("ok");
      expect(daemon.message).toContain("no resume loop running");
      expect(report.ok).toBe(true);
    });

    it("warns when jobs are waiting but no loop is running", () => {
      const report = runDiagnostics(input({ heartbeat: { present: false }, store: store(2) }));
      const daemon = find(report, "daemon");
      expect(daemon.level).toBe("warning");
      expect(daemon.message).toContain("2 job(s) are waiting");
      expect(daemon.message).toContain("no resume loop is running");
      expect(daemon.hint).toContain("agentrelay daemon");
      // warnings don't fail the report
      expect(report.ok).toBe(true);
    });

    it("is OK with a fresh daemon heartbeat and reports pid + age", () => {
      const report = runDiagnostics(
        input({
          heartbeat: { present: true, mode: "daemon", pid: 4242, ageMs: 5_000, staleAfterMs: 90_000 },
          store: store(1),
        })
      );
      const daemon = find(report, "daemon");
      expect(daemon.level).toBe("ok");
      expect(daemon.message).toContain("daemon");
      expect(daemon.message).toContain("pid 4242");
      expect(daemon.message).toContain("5s ago");
      expect(daemon.message).toContain("1 waiting job(s) will resume");
    });

    it("warns when the heartbeat is stale and jobs are waiting", () => {
      const report = runDiagnostics(
        input({
          heartbeat: { present: true, mode: "daemon", pid: 7, ageMs: 300_000, staleAfterMs: 90_000 },
          store: store(3),
        })
      );
      const daemon = find(report, "daemon");
      expect(daemon.level).toBe("warning");
      expect(daemon.message).toContain("looks stopped");
      expect(daemon.message).toContain("3 job(s) are waiting");
      expect(daemon.hint).toContain("agentrelay daemon");
    });

    it("gives a mild stale warning when nothing is waiting", () => {
      const report = runDiagnostics(
        input({
          heartbeat: { present: true, mode: "daemon", pid: 7, ageMs: 300_000, staleAfterMs: 90_000 },
          store: store(0),
        })
      );
      const daemon = find(report, "daemon");
      expect(daemon.level).toBe("warning");
      expect(daemon.message).toContain("heartbeat is stale");
      expect(daemon.message).toContain("may have stopped");
    });

    it("recognizes a live one-shot tick heartbeat", () => {
      const report = runDiagnostics(
        input({
          heartbeat: { present: true, mode: "tick", pid: 99, ageMs: 60_000, staleAfterMs: 900_000 },
          store: store(1),
        })
      );
      const daemon = find(report, "daemon");
      expect(daemon.level).toBe("ok");
      expect(daemon.message).toContain("tick");
    });
  });
});

describe("distinctActiveBinaries", () => {
  it("returns the distinct command[0] of active jobs with counts", () => {
    const jobs = [
      job({ status: "queued", command: ["claude", "-p", "a"] }),
      job({ status: "waiting_for_reset", command: ["claude", "-p", "b"] }),
      job({ status: "resuming", command: ["codex", "run"] }),
    ];
    expect(distinctActiveBinaries(jobs)).toEqual([
      { binary: "claude", neededBy: 2 },
      { binary: "codex", neededBy: 1 },
    ]);
  });

  it("ignores terminal jobs — they are never re-spawned", () => {
    const jobs = [
      job({ status: "completed", command: ["claude"] }),
      job({ status: "failed", command: ["codex"] }),
      job({ status: "cancelled", command: ["gemini"] }),
    ];
    expect(distinctActiveBinaries(jobs)).toEqual([]);
  });

  it("skips a malformed job with an empty command[0]", () => {
    const jobs = [job({ status: "queued", command: ["   "] }), job({ status: "queued", command: [] as string[] })];
    expect(distinctActiveBinaries(jobs)).toEqual([]);
  });
});

const NOW = Date.parse("2026-08-19T00:00:00.000Z");
const HORIZON = 8 * 24 * 60 * 60_000; // 8 days

describe("farFutureResets", () => {
  it("flags an active job whose reset is beyond the horizon", () => {
    const jobs = [job({ status: "waiting_for_reset", project: "web", resetAt: "2027-08-19T00:00:00.000Z" })];
    const out = farFutureResets(jobs, { nowMs: NOW, maxFutureMs: HORIZON });
    expect(out).toHaveLength(1);
    expect(out[0].project).toBe("web");
    expect(out[0].aheadMs).toBe(Date.parse("2027-08-19T00:00:00.000Z") - NOW);
  });

  it("ignores a reset comfortably inside the horizon", () => {
    const jobs = [job({ status: "waiting_for_reset", resetAt: "2026-08-20T00:00:00.000Z" })];
    expect(farFutureResets(jobs, { nowMs: NOW, maxFutureMs: HORIZON })).toEqual([]);
  });

  it("ignores a past reset (window already cleared)", () => {
    const jobs = [job({ status: "waiting_for_reset", resetAt: "2020-01-01T00:00:00.000Z" })];
    expect(farFutureResets(jobs, { nowMs: NOW, maxFutureMs: HORIZON })).toEqual([]);
  });

  it("ignores terminal jobs even with a far-future reset", () => {
    const jobs = [
      job({ status: "completed", resetAt: "2030-01-01T00:00:00.000Z" }),
      job({ status: "cancelled", resetAt: "2030-01-01T00:00:00.000Z" }),
    ];
    expect(farFutureResets(jobs, { nowMs: NOW, maxFutureMs: HORIZON })).toEqual([]);
  });

  it("skips jobs with no or unparseable resetAt", () => {
    const jobs = [job({ status: "queued", resetAt: null }), job({ status: "queued", resetAt: "not-a-date" })];
    expect(farFutureResets(jobs, { nowMs: NOW, maxFutureMs: HORIZON })).toEqual([]);
  });

  it("flags nothing when the guard is disabled (null / non-positive)", () => {
    const jobs = [job({ status: "waiting_for_reset", resetAt: "2030-01-01T00:00:00.000Z" })];
    expect(farFutureResets(jobs, { nowMs: NOW, maxFutureMs: null })).toEqual([]);
    expect(farFutureResets(jobs, { nowMs: NOW, maxFutureMs: 0 })).toEqual([]);
    expect(farFutureResets(jobs, { nowMs: NOW, maxFutureMs: Number.POSITIVE_INFINITY })).toEqual([]);
  });

  it("preserves store order", () => {
    const jobs = [
      job({ id: "a", status: "queued", resetAt: "2029-01-01T00:00:00.000Z" }),
      job({ id: "b", status: "queued", resetAt: "2028-01-01T00:00:00.000Z" }),
    ];
    expect(farFutureResets(jobs, { nowMs: NOW, maxFutureMs: HORIZON }).map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("reset-horizon check", () => {
  it("is OK when no active job is far-future", () => {
    const report = runDiagnostics(input({ resetHorizon: { maxFutureMs: HORIZON, farFuture: [] } }));
    const check = find(report, "reset-horizon");
    expect(check.level).toBe("ok");
    expect(report.ok).toBe(true);
  });

  it("is OK (not judged) when the guard is disabled", () => {
    const report = runDiagnostics(input({ resetHorizon: { maxFutureMs: null, farFuture: [] } }));
    const check = find(report, "reset-horizon");
    expect(check.level).toBe("ok");
    expect(check.message).toMatch(/disabled/);
  });

  it("warns and names the worst offender when jobs are far-future", () => {
    const report = runDiagnostics(
      input({
        resetHorizon: {
          maxFutureMs: HORIZON,
          farFuture: [
            {
              id: "short111-rest",
              project: "web",
              resetAt: "2027-01-01T00:00:00.000Z",
              aheadMs: 30 * 24 * 60 * 60_000,
            },
            {
              id: "worst222-rest",
              project: "api",
              resetAt: "2030-01-01T00:00:00.000Z",
              aheadMs: 900 * 24 * 60 * 60_000,
            },
          ],
        },
      })
    );
    const check = find(report, "reset-horizon");
    expect(check.level).toBe("warning");
    expect(check.message).toContain("2 job(s)");
    // Worst = the one furthest out (api).
    expect(check.message).toContain("worst222");
    expect(check.message).toContain("api");
    expect(check.hint).toMatch(/agentrelay show/);
    // A warning does not fail the overall report.
    expect(report.ok).toBe(true);
  });
});
