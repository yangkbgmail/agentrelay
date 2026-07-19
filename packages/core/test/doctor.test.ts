import { describe, expect, it } from "vitest";
import type { ConfigIssue } from "../src/config.js";
import {
  countActiveJobs,
  DEFAULT_OVERDUE_GRACE_MS,
  type DiagnosticInput,
  distinctActiveBinaries,
  findOverdueJobs,
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
    overdue: { jobs: [] },
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
    expect(find(report, "queue-progress").level).toBe("ok");
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
    expect(report.counts.ok).toBe(5); // store + store-writable + adapters + queue-progress + config
    expect(report.ok).toBe(false);
  });

  it("reports queue-progress OK when nothing is overdue", () => {
    const report = runDiagnostics(input({ overdue: { jobs: [] } }));
    const progress = find(report, "queue-progress");
    expect(progress.level).toBe("ok");
    expect(progress.message).toContain("keeping up");
    expect(report.ok).toBe(true);
  });

  it("warns (not errors) when jobs are overdue, naming the oldest and suggesting the daemon", () => {
    const report = runDiagnostics(
      input({
        overdue: {
          jobs: [
            { id: "a", project: "demo", overdueByMs: 3 * 60 * 60 * 1000 },
            { id: "b", project: "demo", overdueByMs: 5 * 60 * 1000 },
          ],
        },
      })
    );
    const progress = find(report, "queue-progress");
    expect(progress.level).toBe("warning");
    expect(progress.message).toContain("2 job(s)");
    expect(progress.message).toContain("3h"); // oldest, coarse-formatted
    expect(progress.hint).toContain("agentrelay daemon");
    expect(report.ok).toBe(true); // a warning, not an error
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

describe("findOverdueJobs", () => {
  const now = Date.parse("2026-07-19T12:00:00.000Z");
  const iso = (deltaMs: number) => new Date(now + deltaMs).toISOString();

  it("flags a waiting job whose reset passed beyond the grace period", () => {
    const jobs = [job({ status: "waiting_for_reset", resetAt: iso(-10 * 60 * 1000) })];
    const overdue = findOverdueJobs(jobs, now);
    expect(overdue).toHaveLength(1);
    expect(overdue[0].overdueByMs).toBe(10 * 60 * 1000);
    expect(overdue[0].project).toBe("demo");
  });

  it("ignores a job still within the grace period", () => {
    const jobs = [job({ status: "waiting_for_reset", resetAt: iso(-(DEFAULT_OVERDUE_GRACE_MS - 1000)) })];
    expect(findOverdueJobs(jobs, now)).toEqual([]);
  });

  it("ignores a job whose reset is still in the future", () => {
    const jobs = [job({ status: "waiting_for_reset", resetAt: iso(60 * 60 * 1000) })];
    expect(findOverdueJobs(jobs, now)).toEqual([]);
  });

  it("only considers waiting_for_reset — not queued/resuming/terminal", () => {
    const past = iso(-60 * 60 * 1000);
    const jobs = [
      job({ status: "queued", resetAt: past }),
      job({ status: "resuming", resetAt: past }),
      job({ status: "completed", resetAt: past }),
      job({ status: "waiting_for_reset", resetAt: past }),
    ];
    expect(findOverdueJobs(jobs, now)).toHaveLength(1);
  });

  it("skips jobs with a missing or unparseable resetAt", () => {
    const jobs = [
      job({ status: "waiting_for_reset", resetAt: null }),
      job({ status: "waiting_for_reset", resetAt: "not-a-date" }),
    ];
    expect(findOverdueJobs(jobs, now)).toEqual([]);
  });

  it("sorts most-overdue first", () => {
    const jobs = [
      job({ id: "recent", status: "waiting_for_reset", resetAt: iso(-5 * 60 * 1000) }),
      job({ id: "ancient", status: "waiting_for_reset", resetAt: iso(-3 * 60 * 60 * 1000) }),
    ];
    expect(findOverdueJobs(jobs, now).map((o) => o.id)).toEqual(["ancient", "recent"]);
  });

  it("honors a custom grace period", () => {
    const jobs = [job({ status: "waiting_for_reset", resetAt: iso(-30 * 1000) })];
    expect(findOverdueJobs(jobs, now)).toEqual([]); // default 60s grace
    expect(findOverdueJobs(jobs, now, 10 * 1000)).toHaveLength(1); // 10s grace
  });
});
