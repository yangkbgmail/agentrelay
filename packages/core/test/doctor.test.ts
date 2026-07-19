import { describe, expect, it } from "vitest";
import type { ConfigIssue } from "../src/config.js";
import {
  countActiveJobs,
  type DiagnosticInput,
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
    config: { path: null, loadError: null, issues: [] },
    notify: { slackWebhook: "https://hooks.slack.com/x" },
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

  it("counts levels and computes ok across all checks", () => {
    const report = runDiagnostics(input({ nodeVersion: "v20.0.0", notify: {} }));
    expect(report.counts.error).toBe(1); // node
    expect(report.counts.warning).toBe(1); // notify
    expect(report.counts.ok).toBe(2); // store + config
    expect(report.ok).toBe(false);
  });
});
