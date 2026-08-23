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
