import type { StoreVerification } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import {
  renderVerify,
  renderVerifyJson,
  STORE_CLEAN_MESSAGE,
  STORE_MISSING_MESSAGE,
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
