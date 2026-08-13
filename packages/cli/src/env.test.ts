import { describeEnv } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { renderEnv, renderEnvJson, runEnv } from "./env.js";

describe("renderEnv", () => {
  it("shows the set count in the header", () => {
    const out = renderEnv(describeEnv({ AGENTRELAY_MAX_CONCURRENT: "3" }));
    expect(out).toMatch(/environment variables \(1 of \d+ set\)/);
  });

  it("marks a set var with its value and [set], unset vars with (unset)/[default]", () => {
    const out = renderEnv(describeEnv({ AGENTRELAY_MAX_CONCURRENT: "3" }));
    expect(out).toMatch(/AGENTRELAY_MAX_CONCURRENT\s+3\s+\[set\]/);
    expect(out).toMatch(/AGENTRELAY_STORE\s+\(unset\)\s+\[default\]/);
  });

  it("prints the description and, when unset, the default hint", () => {
    const out = renderEnv(describeEnv({}));
    expect(out).toContain("Path to the JSON job store the queue reads and writes.");
    expect(out).toContain("default: ~/.agentrelay/jobs.json");
  });

  it("masks secret values by default and reveals them with showSecrets", () => {
    const env = { AGENTRELAY_SLACK_WEBHOOK: "https://hooks.example/T00/B00/xxxxSECRET" };
    const masked = renderEnv(describeEnv(env));
    expect(masked).not.toContain("xxxxSECRET");
    expect(masked).toMatch(/•+CRET/);

    const revealed = renderEnv(describeEnv(env), { showSecrets: true });
    expect(revealed).toContain("https://hooks.example/T00/B00/xxxxSECRET");
  });

  it("groups vars under their category labels", () => {
    const out = renderEnv(describeEnv({}));
    expect(out).toContain("notifications");
    expect(out).toContain("scheduler");
    expect(out).toContain("auto-prune");
  });

  it("emits no ANSI codes when color is off", () => {
    const out = renderEnv(describeEnv({ AGENTRELAY_STORE: "/tmp/j.json" }), { color: false });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting ESC is absent
    expect(out).not.toMatch(/\x1b\[/);
  });

  it("wraps set values in green when color is on", () => {
    const out = renderEnv(describeEnv({ AGENTRELAY_STORE: "/tmp/j.json" }), { color: true });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting a colour code is present
    expect(out).toMatch(/\x1b\[32m\[set\]\x1b\[0m/);
  });
});

describe("renderEnvJson", () => {
  it("is valid JSON with total/set counts and a var per registry entry", () => {
    const states = describeEnv({ AGENTRELAY_MAX_CONCURRENT: "2" });
    const parsed = JSON.parse(renderEnvJson(states, { generatedAt: "2026-08-13T00:00:00.000Z" }));
    expect(parsed.generatedAt).toBe("2026-08-13T00:00:00.000Z");
    expect(parsed.total).toBe(states.length);
    expect(parsed.set).toBe(1);
    expect(parsed.vars).toHaveLength(states.length);
    const conc = parsed.vars.find((v: { key: string }) => v.key === "AGENTRELAY_MAX_CONCURRENT");
    expect(conc.set).toBe(true);
    expect(conc.value).toBe("2");
    expect(conc.configBacked).toBe(false);
  });

  it("redacts secret values in JSON unless showSecrets is set", () => {
    const env = { AGENTRELAY_WEBHOOK_AUTH: "Bearer supersecrettoken" };
    const redacted = JSON.parse(renderEnvJson(describeEnv(env)));
    const authR = redacted.vars.find((v: { key: string }) => v.key === "AGENTRELAY_WEBHOOK_AUTH");
    expect(authR.value).not.toContain("supersecrettoken");

    const shown = JSON.parse(renderEnvJson(describeEnv(env), { showSecrets: true }));
    const authS = shown.vars.find((v: { key: string }) => v.key === "AGENTRELAY_WEBHOOK_AUTH");
    expect(authS.value).toBe("Bearer supersecrettoken");
  });

  it("reports unset values as null", () => {
    const parsed = JSON.parse(renderEnvJson(describeEnv({})));
    for (const v of parsed.vars) {
      expect(v.value).toBeNull();
      expect(v.set).toBe(false);
    }
  });
});

describe("runEnv", () => {
  it("returns JSON when json:true and text otherwise", () => {
    const json = runEnv({ json: true, env: {} });
    expect(() => JSON.parse(json)).not.toThrow();
    const text = runEnv({ json: false, env: {} });
    expect(text).toContain("environment variables");
  });
});
