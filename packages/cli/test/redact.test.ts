import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REDACTION_PLACEHOLDER, type RelayJob, RelayQueue, type StoreRedactionPlan } from "@agentrelay/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { redactStore } from "../src/commands.js";
import { renderRedact, renderRedactJson } from "../src/redact.js";

function plan(overrides: Partial<StoreRedactionPlan> = {}): StoreRedactionPlan {
  return { changes: [], jobs: [], totalFields: 0, ...overrides };
}

describe("renderRedact", () => {
  it("says nothing to redact when the plan is empty", () => {
    const out = renderRedact(plan({ jobs: [{} as RelayJob, {} as RelayJob] }));
    expect(out).toBe("No secrets found in 2 job(s). Nothing to redact.");
  });

  it("lists each changed job with its fields and a total line", () => {
    const p = plan({
      changes: [
        { id: "abcdef1234", project: "web", fields: ["lastOutputTail", "lastError"] },
        { id: "99999999zz", project: "api", fields: ["rawMatch"] },
      ],
      jobs: [{} as RelayJob, {} as RelayJob, {} as RelayJob],
      totalFields: 3,
    });
    const out = renderRedact(p);
    expect(out).toContain("abcdef12"); // id truncated to 8
    expect(out).toContain("web");
    expect(out).toContain("lastOutputTail, lastError");
    expect(out).toContain("Redacted 3 fields across 2 jobs.");
    expect(out).not.toContain("No changes made");
  });

  it("frames a dry run as a preview that changes nothing", () => {
    const p = plan({
      changes: [{ id: "abcdef1234", project: "web", fields: ["lastError"] }],
      jobs: [{} as RelayJob],
      totalFields: 1,
    });
    const out = renderRedact(p, { dryRun: true });
    expect(out).toContain("Would redact 1 field across 1 job.");
    expect(out).toContain("No changes made.");
  });
});

describe("renderRedactJson", () => {
  it("emits totals, dryRun, and the full (untruncated) change log", () => {
    const p = plan({
      changes: [{ id: "abcdef1234", project: "web", fields: ["lastError"] }],
      jobs: [{} as RelayJob, {} as RelayJob],
      totalFields: 1,
    });
    const parsed = JSON.parse(
      renderRedactJson(p, "/tmp/jobs.json", { dryRun: true, generatedAt: "2026-08-23T00:00:00.000Z" })
    );
    expect(parsed).toMatchObject({
      storePath: "/tmp/jobs.json",
      generatedAt: "2026-08-23T00:00:00.000Z",
      dryRun: true,
      totalJobs: 2,
      changedJobs: 1,
      totalFields: 1,
      changes: [{ id: "abcdef1234", project: "web", fields: ["lastError"] }],
    });
  });
});

function makeJob(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "job-1",
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "hi"],
    cwd: "/tmp/demo",
    status: "completed",
    resetAt: null,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:05:00.000Z",
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("redactStore", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-redact-cli-"));
    storePath = join(dir, "jobs.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(jobs: RelayJob[]): void {
    writeFileSync(storePath, JSON.stringify(jobs, null, 2), "utf8");
  }

  it("scrubs secrets from stored jobs and persists the change", () => {
    seed([
      makeJob({ id: "leaky", status: "failed", lastError: "boom ghp_ABCdef1234567890ghijklmn" }),
      makeJob({ id: "clean", lastOutputTail: "all good" }),
    ]);
    const result = redactStore({ storePath });
    expect(result.changes.map((c) => c.id)).toEqual(["leaky"]);
    expect(result.totalFields).toBe(1);

    const after = new RelayQueue(storePath).getById("leaky");
    expect(after?.lastError).toBe(`boom ${REDACTION_PLACEHOLDER}`);
    expect(after?.lastError).not.toContain("ghp_");
  });

  it("preserves updatedAt when scrubbing (content cleanup, not a lifecycle event)", () => {
    seed([
      makeJob({
        id: "leaky",
        status: "failed",
        lastError: "ghp_ABCdef1234567890ghijklmn",
        updatedAt: "2026-08-23T00:05:00.000Z",
      }),
    ]);
    redactStore({ storePath });
    expect(new RelayQueue(storePath).getById("leaky")?.updatedAt).toBe("2026-08-23T00:05:00.000Z");
  });

  it("dry-run reports the plan but writes nothing", () => {
    seed([makeJob({ id: "leaky", status: "failed", lastError: "ghp_ABCdef1234567890ghijklmn" })]);
    const result = redactStore({ storePath, dryRun: true });
    expect(result.changes).toHaveLength(1);
    expect(new RelayQueue(storePath).getById("leaky")?.lastError).toContain("ghp_"); // untouched on disk
  });

  it("reports nothing to redact for a clean store", () => {
    seed([makeJob({ id: "a", lastOutputTail: "fine" })]);
    const result = redactStore({ storePath });
    expect(result.changes).toEqual([]);
    expect(result.totalFields).toBe(0);
  });
});
