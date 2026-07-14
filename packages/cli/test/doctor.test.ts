import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DoctorReport } from "@agentrelay/core";
import { runDoctorChecks } from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gatherDoctorInput } from "../src/commands.js";
import { renderDoctor, renderDoctorJson } from "../src/doctor.js";

function report(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    ok: true,
    checks: [
      { name: "node", status: "ok", detail: "Node 22.5.0 (>= 22.5.0)" },
      { name: "notifiers", status: "warn", detail: "No notifiers configured." },
    ],
    ...overrides,
  };
}

describe("renderDoctor", () => {
  it("renders one line per check plus a summary", () => {
    const out = renderDoctor(report());
    expect(out).toContain("node");
    expect(out).toContain("Node 22.5.0");
    expect(out).toContain("notifiers");
    // ok with a warning present.
    expect(out).toContain("All critical checks passed (1 warning(s)).");
  });

  it("reports a clean bill of health when there are no warnings", () => {
    const out = renderDoctor(report({ checks: [{ name: "node", status: "ok", detail: "fine" }] }));
    expect(out).toContain("All checks passed.");
  });

  it("summarizes the number of problems when not ok", () => {
    const out = renderDoctor(
      report({
        ok: false,
        checks: [
          { name: "store", status: "error", detail: "not writable" },
          { name: "config", status: "error", detail: "broken" },
        ],
      })
    );
    expect(out).toContain("2 problem(s) found");
  });

  it("emits ANSI codes only when color is on", () => {
    expect(renderDoctor(report(), { color: false })).not.toContain("\x1b[");
    expect(renderDoctor(report(), { color: true })).toContain("\x1b[");
  });
});

describe("renderDoctorJson", () => {
  it("wraps the report in a machine-readable envelope", () => {
    const json = JSON.parse(renderDoctorJson(report({ ok: false }), "/tmp/jobs.json", "2026-07-14T00:00:00.000Z"));
    expect(json.storePath).toBe("/tmp/jobs.json");
    expect(json.generatedAt).toBe("2026-07-14T00:00:00.000Z");
    expect(json.ok).toBe(false);
    expect(Array.isArray(json.checks)).toBe(true);
    expect(json.checks[0].name).toBe("node");
  });
});

describe("gatherDoctorInput", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-doctor-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports the store as absent-but-writable when the file does not exist", () => {
    const storePath = join(dir, "sub", "jobs.json");
    const input = gatherDoctorInput(storePath);
    expect(input.store.path).toBe(storePath);
    expect(input.store.exists).toBe(false);
    expect(input.store.writable).toBe(true); // dir exists and is writable
    expect(input.store.parseError).toBeNull();
    expect(input.nodeVersion).toBe(process.versions.node);
  });

  it("counts jobs in a valid store file", () => {
    const storePath = join(dir, "jobs.json");
    writeFileSync(storePath, JSON.stringify([{ id: "a" }, { id: "b" }]), "utf8");
    const input = gatherDoctorInput(storePath);
    expect(input.store.exists).toBe(true);
    expect(input.store.jobCount).toBe(2);
    expect(input.store.parseError).toBeNull();
  });

  it("flags a malformed store file with a parse error", () => {
    const storePath = join(dir, "jobs.json");
    writeFileSync(storePath, "{ not json", "utf8");
    const input = gatherDoctorInput(storePath);
    expect(input.store.jobCount).toBeNull();
    expect(input.store.parseError).not.toBeNull();
    // A JSON object (not an array) is also a parse error.
    writeFileSync(storePath, JSON.stringify({ jobs: [] }), "utf8");
    expect(gatherDoctorInput(storePath).store.parseError).toContain("array");
  });

  it("feeds cleanly into runDoctorChecks", () => {
    const storePath = join(dir, "jobs.json");
    writeFileSync(storePath, "[]", "utf8");
    const result = runDoctorChecks(gatherDoctorInput(storePath));
    expect(result.ok).toBe(true);
    expect(result.checks.find((c) => c.name === "store")?.status).toBe("ok");
  });
});
