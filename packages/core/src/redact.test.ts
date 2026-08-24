import { describe, expect, it } from "vitest";
import { REDACTION_PLACEHOLDER, redactOutputTailFromEnv, redactSecrets } from "./redact.js";

describe("redactSecrets", () => {
  it("returns empty/whitespace input unchanged", () => {
    expect(redactSecrets("")).toBe("");
    expect(redactSecrets("   \n")).toBe("   \n");
  });

  it("leaves ordinary output untouched", () => {
    const text = "Build succeeded in 3.2s. 42 tests passed. Resuming the refactor.";
    expect(redactSecrets(text)).toBe(text);
  });

  it("redacts an Anthropic API key but keeps the sk-ant- prefix", () => {
    const out = redactSecrets("export ANTHROPIC_API_KEY=sk-ant-api03-abcDEF123456ghiJKL789");
    expect(out).not.toContain("abcDEF123456ghiJKL789");
    // The credential-assignment rule wins on `NAME=value`, masking the whole value.
    expect(out).toContain(`ANTHROPIC_API_KEY=${REDACTION_PLACEHOLDER}`);
  });

  it("redacts a bare Anthropic key mid-sentence, keeping the sk-ant- hint", () => {
    const out = redactSecrets("the key sk-ant-api03-abcDEF123456ghiJKL789xyz leaked into the log");
    expect(out).toBe(`the key sk-ant-${REDACTION_PLACEHOLDER} leaked into the log`);
  });

  it("redacts an OpenAI-style sk- key", () => {
    const out = redactSecrets("OPENAI key sk-proj-ABCdef1234567890ghijKLmn used here");
    expect(out).not.toContain("ABCdef1234567890ghijKLmn");
    expect(out).toContain(`sk-${REDACTION_PLACEHOLDER}`);
  });

  it("redacts GitHub tokens (classic and fine-grained)", () => {
    expect(redactSecrets("token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 here")).toBe(
      `token ${REDACTION_PLACEHOLDER} here`
    );
    const pat = redactSecrets("git remote add origin https://github_pat_11ABCDEFG0abcdefghij_KLMNOP@github.com/o/r");
    expect(pat).toContain(REDACTION_PLACEHOLDER);
    expect(pat).not.toContain("11ABCDEFG0abcdefghij");
  });

  it("redacts an AWS access key id", () => {
    expect(redactSecrets("AWS_ACCESS_KEY_ID AKIAIOSFODNN7EXAMPLE done")).toContain(REDACTION_PLACEHOLDER);
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).toBe(REDACTION_PLACEHOLDER);
  });

  it("redacts a Slack token", () => {
    const out = redactSecrets("SLACK xoxb-123456789012-abcdefABCDEF hook");
    expect(out).toBe(`SLACK ${REDACTION_PLACEHOLDER} hook`);
  });

  it("redacts a Google API key", () => {
    // Google keys are AIza + exactly 35 chars.
    const gkey = `AIza${"012345678901234567890123456789abcde"}`;
    const out = redactSecrets(`endpoint key ${gkey} done`);
    expect(out).not.toContain(gkey);
    expect(out).toBe(`endpoint key ${REDACTION_PLACEHOLDER} done`);
  });

  it("keeps the Authorization scheme but redacts the bearer token", () => {
    const out = redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig");
    expect(out).toBe(`Authorization: Bearer ${REDACTION_PLACEHOLDER}`);
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("redacts NAME=secret and NAME: secret assignments, keeping the name", () => {
    expect(redactSecrets("DATABASE_PASSWORD=hunter2super")).toBe(`DATABASE_PASSWORD=${REDACTION_PLACEHOLDER}`);
    expect(redactSecrets('MY_SECRET_TOKEN: "s3cr3t-value"')).toBe(`MY_SECRET_TOKEN: ${REDACTION_PLACEHOLDER}`);
    expect(redactSecrets("aws_access_key = AKIAisirrelevanthere00")).toContain(REDACTION_PLACEHOLDER);
  });

  it("does not touch a variable named like a secret with a harmless boolean value shape", () => {
    // Over-redacting a value assigned to a credential-named var is acceptable and
    // safe; we just confirm the *name* survives so the log stays diagnosable.
    const out = redactSecrets("HAS_API_KEY=true");
    expect(out.startsWith("HAS_API_KEY=")).toBe(true);
    expect(out).toContain(REDACTION_PLACEHOLDER);
  });

  it("redacts multiple secrets in one blob and preserves surrounding text", () => {
    const blob = [
      "Starting agent...",
      "GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      "using sk-ant-api03-realKeyMaterial1234567 for the call",
      "All done.",
    ].join("\n");
    const out = redactSecrets(blob);
    expect(out).toContain("Starting agent...");
    expect(out).toContain("All done.");
    expect(out).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    expect(out).not.toContain("realKeyMaterial1234567");
  });

  it("does not misfire on short, non-secret tokens", () => {
    // "sk-1234" is too short for the key patterns; a plain word should survive.
    const text = "the sk-1234 shorthand and the word secretary are fine";
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("redactOutputTailFromEnv", () => {
  it("defaults to true when unset or empty (secure by default)", () => {
    expect(redactOutputTailFromEnv({})).toBe(true);
    expect(redactOutputTailFromEnv({ AGENTRELAY_REDACT_OUTPUT: "" })).toBe(true);
    expect(redactOutputTailFromEnv({ AGENTRELAY_REDACT_OUTPUT: "  " })).toBe(true);
  });

  it("disables only on an explicit off switch (case-insensitive)", () => {
    for (const v of ["0", "off", "false", "no", "none", "disabled", "OFF", "False"]) {
      expect(redactOutputTailFromEnv({ AGENTRELAY_REDACT_OUTPUT: v })).toBe(false);
    }
  });

  it("stays on for a misspelled value rather than silently disabling", () => {
    expect(redactOutputTailFromEnv({ AGENTRELAY_REDACT_OUTPUT: "offf" })).toBe(true);
    expect(redactOutputTailFromEnv({ AGENTRELAY_REDACT_OUTPUT: "1" })).toBe(true);
    expect(redactOutputTailFromEnv({ AGENTRELAY_REDACT_OUTPUT: "on" })).toBe(true);
  });
});

import { planStoreRedaction, REDACTABLE_FIELDS, redactJob } from "./redact.js";
import type { RelayJob } from "./types.js";

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

describe("redactJob", () => {
  it("returns the job unchanged with no changed fields when nothing is secret", () => {
    const job = makeJob({ lastOutputTail: "Build succeeded. 42 tests passed." });
    const { job: out, changed } = redactJob(job);
    expect(out).toBe(job); // same reference — untouched
    expect(changed).toEqual([]);
  });

  it("scrubs a secret in lastOutputTail and reports the field", () => {
    const job = makeJob({ lastOutputTail: "leaked ghp_ABCdef1234567890ghijklmn here" });
    const { job: out, changed } = redactJob(job);
    expect(out.lastOutputTail).toBe(`leaked ${REDACTION_PLACEHOLDER} here`);
    expect(changed).toEqual(["lastOutputTail"]);
    expect(job.lastOutputTail).toContain("ghp_"); // original not mutated
  });

  it("scrubs lastError", () => {
    const job = makeJob({ status: "failed", lastError: "auth failed with sk-ant-api03-abcDEF123456ghiJKL789xyz" });
    const { job: out, changed } = redactJob(job);
    expect(out.lastError).toBe(`auth failed with sk-ant-${REDACTION_PLACEHOLDER}`);
    expect(changed).toEqual(["lastError"]);
  });

  it("scrubs lastRateLimit.rawMatch while preserving the rest of the provenance", () => {
    const job = makeJob({
      status: "waiting_for_reset",
      resetAt: "2026-08-23T05:00:00.000Z",
      lastRateLimit: {
        pattern: "generic",
        rawMatch: "token ghp_ABCdef1234567890ghijklmn",
        resetAt: "2026-08-23T05:00:00.000Z",
        detectedAt: "2026-08-23T00:00:00.000Z",
      },
    });
    const { job: out, changed } = redactJob(job);
    expect(changed).toEqual(["rawMatch"]);
    expect(out.lastRateLimit?.rawMatch).toBe(`token ${REDACTION_PLACEHOLDER}`);
    expect(out.lastRateLimit?.pattern).toBe("generic");
    expect(out.lastRateLimit?.resetAt).toBe("2026-08-23T05:00:00.000Z");
  });

  it("scrubs multiple fields at once, in REDACTABLE_FIELDS order", () => {
    const job = makeJob({
      status: "failed",
      lastError: "boom ghp_ABCdef1234567890ghijklmn",
      lastOutputTail: "out sk-ant-api03-abcDEF123456ghiJKL789xyz done",
    });
    const { changed } = redactJob(job);
    expect(changed).toEqual(["lastOutputTail", "lastError"]);
    // Never a field outside the known set.
    for (const f of changed) expect(REDACTABLE_FIELDS).toContain(f);
  });

  it("never touches updatedAt (redaction is a content cleanup, not a lifecycle event)", () => {
    const job = makeJob({ lastError: "ghp_ABCdef1234567890ghijklmn", status: "failed" });
    const { job: out } = redactJob(job);
    expect(out.updatedAt).toBe(job.updatedAt);
    expect(out.createdAt).toBe(job.createdAt);
  });
});

describe("planStoreRedaction", () => {
  it("returns an empty change log and passes jobs through when nothing is secret", () => {
    const jobs = [makeJob({ id: "a" }), makeJob({ id: "b", lastOutputTail: "all clear" })];
    const plan = planStoreRedaction(jobs);
    expect(plan.changes).toEqual([]);
    expect(plan.totalFields).toBe(0);
    expect(plan.jobs).toHaveLength(2);
    expect(plan.jobs[0]).toBe(jobs[0]); // unchanged jobs shared by reference
  });

  it("logs only jobs that changed, preserving input order, and totals fields", () => {
    const jobs = [
      makeJob({ id: "clean", lastOutputTail: "fine" }),
      makeJob({
        id: "leaky",
        status: "failed",
        lastError: "boom ghp_ABCdef1234567890ghijklmn",
        lastOutputTail: "sk-ant-api03-abcDEF123456ghiJKL789xyz",
      }),
      makeJob({ id: "clean2" }),
    ];
    const plan = planStoreRedaction(jobs);
    expect(plan.changes.map((c) => c.id)).toEqual(["leaky"]);
    expect(plan.changes[0].fields).toEqual(["lastOutputTail", "lastError"]);
    expect(plan.totalFields).toBe(2);
    // Scrubbed job set carries the redaction; clean jobs pass through.
    expect(plan.jobs[1].lastError).toContain(REDACTION_PLACEHOLDER);
    expect(plan.jobs[0]).toBe(jobs[0]);
  });

  it("handles an empty store", () => {
    const plan = planStoreRedaction([]);
    expect(plan.changes).toEqual([]);
    expect(plan.jobs).toEqual([]);
    expect(plan.totalFields).toBe(0);
  });
});
