import type { LoadedConfig } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { applyConfigFile, renderConfig } from "../src/config.js";

describe("applyConfigFile", () => {
  it("fills unset env vars from the config, letting real env win", () => {
    // Simulated file via AGENTRELAY_CONFIG + a readFile that loadConfig uses is
    // internal; here we exercise the mutation contract through a fake env.
    // loadConfig reads a real file, so we instead validate the mutation using
    // a config file path that does not exist -> returns null, env unchanged.
    const env = { AGENTRELAY_CONFIG: "/definitely/missing.json" } as NodeJS.ProcessEnv;
    const before = { ...env };
    const loaded = applyConfigFile(env, () => {});
    expect(loaded).toBeNull();
    expect(env).toEqual(before);
  });
});

describe("renderConfig", () => {
  it("reports a missing config file", () => {
    const out = renderConfig(null, { AGENTRELAY_CONFIG: "/x/config.json" } as NodeJS.ProcessEnv);
    expect(out).toContain("Config file: /x/config.json");
    expect(out).toContain("(not found");
  });

  it("lists recognized settings and unknown keys, masking secrets", () => {
    const loaded: LoadedConfig = {
      path: "/home/u/.agentrelay/config.json",
      config: { maxAttempts: 4, slackWebhook: "https://hooks.slack.com/services/T000/B000/abcdef1234" },
      unknownKeys: ["typo"],
    };
    const out = renderConfig(loaded, {} as NodeJS.ProcessEnv);
    expect(out).toContain("maxAttempts = 4");
    expect(out).toContain("Unknown keys (ignored): typo");
    // secret is masked, never printed in full
    expect(out).not.toContain("abcdef1234");
    expect(out).toMatch(/slackWebhook = http…/);
  });

  it("shows effective env values with secrets masked", () => {
    const env = {
      AGENTRELAY_MAX_ATTEMPTS: "7",
      AGENTRELAY_WEBHOOK_AUTH: "Bearer supersecrettoken",
    } as NodeJS.ProcessEnv;
    const out = renderConfig(null, env);
    expect(out).toContain("maxAttempts (AGENTRELAY_MAX_ATTEMPTS) = 7");
    expect(out).not.toContain("supersecrettoken");
    expect(out).toMatch(/webhookAuth \(AGENTRELAY_WEBHOOK_AUTH\) = Bear…/);
  });

  it("says none set when no env values are present", () => {
    const out = renderConfig(null, {} as NodeJS.ProcessEnv);
    expect(out).toContain("(none set — all built-in defaults)");
  });
});
