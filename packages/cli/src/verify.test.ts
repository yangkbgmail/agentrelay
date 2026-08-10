import type { RelayJob, RepairAction, StoreRepair, StoreVerification } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import {
  REPAIR_CLEAN_MESSAGE,
  REPAIR_MISSING_MESSAGE,
  renderVerify,
  renderVerifyFix,
  renderVerifyFixJson,
  renderVerifyJson,
  STORE_CLEAN_MESSAGE,
  STORE_MISSING_MESSAGE,
  type VerifyFixReport,
  type VerifyReport,
} from "./verify.js";

function verification(overrides: Partial<StoreVerification> = {}): StoreVerification {
  return {
    total: 0,
    validJobs: 0,
    errorCount: 0,
    warningCount: 0,
    ok: true,
    issues: [],
    ...overrides,
  };
}

describe("renderVerify", () => {
  it("reports a missing store as a clean first-run state", () => {
    const out = renderVerify({ kind: "missing", store: "/x/jobs.json" });
    expect(out).toContain("Store verification");
    expect(out).toContain("/x/jobs.json");
    expect(out).toContain(STORE_MISSING_MESSAGE);
  });

  it("reports whole-file corruption with the reason", () => {
    const out = renderVerify({
      kind: "corrupt",
      store: "/x/jobs.json",
      corruptReason: "root is not a JSON array of jobs",
    });
    expect(out).toContain("not a readable JSON array");
    expect(out).toContain("root is not a JSON array of jobs");
  });

  it("shows a healthy message when there are no issues", () => {
    const report: VerifyReport = {
      kind: "verified",
      store: "/x/jobs.json",
      verification: verification({ total: 2, validJobs: 2 }),
    };
    const out = renderVerify(report);
    expect(out).toContain("2 record(s) — 2 valid, 0 error(s), 0 warning(s)");
    expect(out).toContain(STORE_CLEAN_MESSAGE);
  });

  it("lists errors before warnings, each with code and record index", () => {
    const report: VerifyReport = {
      kind: "verified",
      store: "/x/jobs.json",
      verification: verification({
        total: 2,
        validJobs: 1,
        errorCount: 1,
        warningCount: 1,
        ok: false,
        issues: [
          {
            level: "warning",
            index: 0,
            jobId: "a",
            code: "clock-skew",
            message: "updatedAt is earlier than createdAt (clock skew)",
          },
          { level: "error", index: 1, jobId: "b", code: "duplicate-id", message: 'duplicate id "b"' },
        ],
      }),
    };
    const out = renderVerify(report);
    const errorPos = out.indexOf("duplicate-id");
    const warnPos = out.indexOf("clock-skew");
    expect(errorPos).toBeGreaterThanOrEqual(0);
    expect(warnPos).toBeGreaterThanOrEqual(0);
    expect(errorPos).toBeLessThan(warnPos); // errors printed first
    expect(out).toContain("#1 b");
    expect(out).toContain("#0 a");
  });

  it("omits the job id from the location when it is null", () => {
    const report: VerifyReport = {
      kind: "verified",
      store: "/x/jobs.json",
      verification: verification({
        total: 1,
        validJobs: 0,
        errorCount: 1,
        ok: false,
        issues: [{ level: "error", index: 0, jobId: null, code: "invalid-record", message: "not a JSON object" }],
      }),
    };
    const out = renderVerify(report);
    expect(out).toContain("#0:");
    expect(out).not.toContain("#0 null");
  });
});

describe("renderVerifyJson", () => {
  it("emits kind + verification for a verified store", () => {
    const v = verification({ total: 1, validJobs: 1 });
    const parsed = JSON.parse(renderVerifyJson({ kind: "verified", store: "/x/jobs.json", verification: v }));
    expect(parsed).toEqual({ store: "/x/jobs.json", kind: "verified", verification: v });
  });

  it("emits corruptReason for a corrupt store and no verification", () => {
    const parsed = JSON.parse(renderVerifyJson({ kind: "corrupt", store: "/x/jobs.json", corruptReason: "bad" }));
    expect(parsed).toEqual({ store: "/x/jobs.json", kind: "corrupt", corruptReason: "bad" });
  });

  it("emits kind only for a missing store", () => {
    const parsed = JSON.parse(renderVerifyJson({ kind: "missing", store: "/x/jobs.json" }));
    expect(parsed).toEqual({ store: "/x/jobs.json", kind: "missing" });
  });
});

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/home/user/demo",
    status: "completed",
    resetAt: null,
    createdAt: "2026-07-24T10:00:00.000Z",
    updatedAt: "2026-07-24T10:05:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function repair(overrides: Partial<StoreRepair> = {}): StoreRepair {
  return {
    verification: verification(),
    kept: [],
    actions: [],
    changed: false,
    ...overrides,
  };
}

const dropInvalid: RepairAction = { kind: "drop-invalid", index: 1, jobId: "bad", reason: "missing project" };
const dropDup: RepairAction = { kind: "drop-duplicate", index: 0, jobId: "dup", reason: 'duplicate id "dup"' };

describe("renderVerifyFix", () => {
  it("reports a missing store as nothing to repair", () => {
    const out = renderVerifyFix({ kind: "missing", store: "/x/jobs.json" });
    expect(out).toContain("Store repair");
    expect(out).toContain(REPAIR_MISSING_MESSAGE);
  });

  it("reports whole-file corruption as unrepairable", () => {
    const out = renderVerifyFix({ kind: "corrupt", store: "/x/jobs.json", corruptReason: "invalid JSON" });
    expect(out).toContain("invalid JSON");
    expect(out).toContain("restore from a backup");
  });

  it("reports a clean store with nothing to repair", () => {
    const out = renderVerifyFix({
      kind: "verified",
      store: "/x/jobs.json",
      repair: repair({ verification: verification({ total: 3 }), changed: false }),
    });
    expect(out).toContain(REPAIR_CLEAN_MESSAGE);
  });

  it("notes remaining warnings even on a clean-of-errors store", () => {
    const out = renderVerifyFix({
      kind: "verified",
      store: "/x/jobs.json",
      repair: repair({ verification: verification({ total: 1, warningCount: 1 }), changed: false }),
    });
    expect(out).toContain(REPAIR_CLEAN_MESSAGE);
    expect(out).toContain("1 warning(s) remain");
  });

  it("lists dropped records and confirms a write", () => {
    const report: VerifyFixReport = {
      kind: "verified",
      store: "/x/jobs.json",
      wrote: true,
      backupPath: "/x/jobs.json.backup-20260724",
      repair: repair({
        verification: verification({ total: 3, errorCount: 2 }),
        kept: [job({ id: "ok" })],
        actions: [dropDup, dropInvalid],
        changed: true,
      }),
    };
    const out = renderVerifyFix(report);
    expect(out).toContain("1 kept, 2 dropped");
    expect(out).toContain("drop invalid");
    expect(out).toContain("drop dup");
    expect(out).toContain("Repaired.");
    expect(out).toContain("Pre-repair backup: /x/jobs.json.backup-20260724");
  });

  it("marks a dry run as not written and points at the real run", () => {
    const report: VerifyFixReport = {
      kind: "verified",
      store: "/x/jobs.json",
      dryRun: true,
      wrote: false,
      repair: repair({
        verification: verification({ total: 2, errorCount: 1 }),
        kept: [job({ id: "ok" })],
        actions: [dropInvalid],
        changed: true,
      }),
    };
    const out = renderVerifyFix(report);
    expect(out).toContain("(dry run)");
    expect(out).toContain("Dry run — no changes written.");
    expect(out).not.toContain("Repaired.");
  });
});

describe("renderVerifyFixJson", () => {
  it("emits the plan + verification for a repaired store", () => {
    const parsed = JSON.parse(
      renderVerifyFixJson({
        kind: "verified",
        store: "/x/jobs.json",
        wrote: true,
        backupPath: "/x/b",
        repair: repair({
          verification: verification({ total: 2, errorCount: 1 }),
          kept: [job({ id: "ok" })],
          actions: [dropInvalid],
          changed: true,
        }),
      })
    );
    expect(parsed.kind).toBe("verified");
    expect(parsed.wrote).toBe(true);
    expect(parsed.backupPath).toBe("/x/b");
    expect(parsed.changed).toBe(true);
    expect(parsed.kept).toBe(1);
    expect(parsed.dropped).toBe(1);
    expect(parsed.actions).toEqual([dropInvalid]);
  });

  it("emits dryRun/wrote flags and no backup for a preview", () => {
    const parsed = JSON.parse(
      renderVerifyFixJson({
        kind: "verified",
        store: "/x/jobs.json",
        dryRun: true,
        wrote: false,
        repair: repair({ changed: false }),
      })
    );
    expect(parsed.dryRun).toBe(true);
    expect(parsed.wrote).toBe(false);
    expect(parsed.backupPath).toBeUndefined();
  });
});
