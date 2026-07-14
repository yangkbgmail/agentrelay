import { describe, expect, it } from "vitest";
import { compareVersions, type DoctorInput, MIN_NODE_VERSION, parseVersion, runDoctorChecks } from "./doctor.js";
import { DEFAULT_RETRY_POLICY } from "./retry.js";

function input(overrides: Partial<DoctorInput> = {}): DoctorInput {
  return {
    nodeVersion: "22.5.0",
    store: { path: "/tmp/jobs.json", exists: true, writable: true, jobCount: 3, parseError: null },
    config: { path: null, error: null },
    notifiers: { slack: false, webhook: false },
    retry: DEFAULT_RETRY_POLICY,
    ...overrides,
  };
}

const findCheck = (r: ReturnType<typeof runDoctorChecks>, name: string) => r.checks.find((c) => c.name === name);

describe("parseVersion", () => {
  it("parses plain, v-prefixed, and suffixed versions", () => {
    expect(parseVersion("22.5.0")).toEqual([22, 5, 0]);
    expect(parseVersion("v22.5.1")).toEqual([22, 5, 1]);
    expect(parseVersion("22.5.0-nightly20240101")).toEqual([22, 5, 0]);
    expect(parseVersion("20.11.0+build")).toEqual([20, 11, 0]);
  });

  it("fills missing/non-numeric segments with zero", () => {
    expect(parseVersion("22")).toEqual([22, 0, 0]);
    expect(parseVersion("22.5")).toEqual([22, 5, 0]);
    expect(parseVersion("")).toEqual([0, 0, 0]);
  });
});

describe("compareVersions", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareVersions("22.5.0", "22.4.9")).toBeGreaterThan(0);
    expect(compareVersions("22.4.0", "22.5.0")).toBeLessThan(0);
    expect(compareVersions("22.5.0", "22.5.0")).toBe(0);
    expect(compareVersions("23.0.0", "22.99.99")).toBeGreaterThan(0);
  });
});

describe("runDoctorChecks", () => {
  it("passes a healthy environment and reports ok", () => {
    const report = runDoctorChecks(input());
    expect(report.ok).toBe(true);
    expect(findCheck(report, "node")?.status).toBe("ok");
    expect(findCheck(report, "store")?.status).toBe("ok");
    expect(findCheck(report, "store")?.detail).toContain("3 job(s)");
  });

  it("errors when Node is below the minimum", () => {
    const report = runDoctorChecks(input({ nodeVersion: "20.10.0" }));
    expect(report.ok).toBe(false);
    const node = findCheck(report, "node");
    expect(node?.status).toBe("error");
    expect(node?.detail).toContain(MIN_NODE_VERSION);
  });

  it("respects an overridden minimum node version", () => {
    const report = runDoctorChecks(input({ nodeVersion: "18.0.0", minNodeVersion: "18.0.0" }));
    expect(findCheck(report, "node")?.status).toBe("ok");
  });

  it("errors on an unparseable store file", () => {
    const report = runDoctorChecks(
      input({
        store: { path: "/s.json", exists: true, writable: true, jobCount: null, parseError: "Unexpected token" },
      })
    );
    expect(report.ok).toBe(false);
    expect(findCheck(report, "store")?.status).toBe("error");
    expect(findCheck(report, "store")?.detail).toContain("Unexpected token");
  });

  it("errors when the store path is not writable", () => {
    const report = runDoctorChecks(
      input({ store: { path: "/ro/s.json", exists: false, writable: false, jobCount: null, parseError: null } })
    );
    expect(report.ok).toBe(false);
    expect(findCheck(report, "store")?.detail).toContain("not writable");
  });

  it("treats an absent-but-writable store as ok (created on first run)", () => {
    const report = runDoctorChecks(
      input({ store: { path: "/new.json", exists: false, writable: true, jobCount: null, parseError: null } })
    );
    expect(findCheck(report, "store")?.status).toBe("ok");
    expect(findCheck(report, "store")?.detail).toContain("does not exist yet");
    expect(report.ok).toBe(true);
  });

  it("reports a loaded config path", () => {
    const report = runDoctorChecks(input({ config: { path: "/home/u/agentrelay.config.json", error: null } }));
    expect(findCheck(report, "config")?.status).toBe("ok");
    expect(findCheck(report, "config")?.detail).toContain("agentrelay.config.json");
  });

  it("errors on a broken config file", () => {
    const report = runDoctorChecks(input({ config: { path: "/bad.json", error: "Invalid JSON" } }));
    expect(report.ok).toBe(false);
    expect(findCheck(report, "config")?.status).toBe("error");
  });

  it("warns when no notifiers are configured, ok when some are", () => {
    expect(findCheck(runDoctorChecks(input()), "notifiers")?.status).toBe("warn");
    const withSlack = runDoctorChecks(input({ notifiers: { slack: true, webhook: false } }));
    expect(findCheck(withSlack, "notifiers")?.status).toBe("ok");
    expect(findCheck(withSlack, "notifiers")?.detail).toContain("slack");
    // A warning alone does not fail the doctor.
    expect(runDoctorChecks(input()).ok).toBe(true);
  });

  it("shows the effective retry policy and warns on incoherent values", () => {
    const okReport = runDoctorChecks(input());
    expect(findCheck(okReport, "retry")?.status).toBe("ok");
    expect(findCheck(okReport, "retry")?.detail).toContain("attempts");

    const bad = runDoctorChecks(input({ retry: { maxAttempts: -1, baseDelayMs: 0, factor: 0.5, maxDelayMs: 10 } }));
    const retry = findCheck(bad, "retry");
    expect(retry?.status).toBe("warn");
    expect(retry?.detail).toContain("maxAttempts is negative");
    // Still not a hard failure.
    expect(bad.ok).toBe(true);
  });

  it("renders unlimited attempts when maxAttempts is 0", () => {
    const report = runDoctorChecks(input({ retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: 0 } }));
    expect(findCheck(report, "retry")?.detail).toContain("unlimited attempts");
  });
});
