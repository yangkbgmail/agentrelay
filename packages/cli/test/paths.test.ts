import { buildLocationReport, type LocationFacts } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { renderLocations, renderLocationsJson } from "../src/paths.js";

const STORE = "/home/u/.agentrelay/jobs.json";

function report(overrides: Partial<LocationFacts> = {}) {
  return buildLocationReport({
    storePath: STORE,
    storeExists: true,
    configPath: null,
    configExists: false,
    heartbeatExists: false,
    storeDirFiles: ["jobs.json"],
    ...overrides,
  });
}

describe("renderLocations", () => {
  it("lists a labeled line for every location with its path", () => {
    const out = renderLocations(report());
    expect(out).toContain("Job store:");
    expect(out).toContain(STORE);
    expect(out).toContain("Store directory:");
    expect(out).toContain("/home/u/.agentrelay");
    expect(out).toContain("Config file:");
    expect(out).toContain("Daemon heartbeat:");
    expect(out).toContain("/home/u/.agentrelay/daemon.json");
    expect(out).toContain("Store backups:");
    expect(out).toContain("jobs.json.backup-*");
  });

  it("marks present locations with ✓ and absent ones with ·", () => {
    const out = renderLocations(report({ storeExists: true, heartbeatExists: false }));
    // store exists → ✓ on its line; heartbeat absent → · on its line.
    const storeLine = out.split("\n").find((l) => l.includes("Job store:"));
    const hbLine = out.split("\n").find((l) => l.includes("Daemon heartbeat:"));
    expect(storeLine).toContain("✓");
    expect(hbLine).toContain("·");
  });

  it("shows the '(none)' placeholder and defaults note when no config is resolved", () => {
    const out = renderLocations(report({ configPath: null }));
    const configLine = out.split("\n").find((l) => l.includes("Config file:"));
    expect(configLine).toContain("(none)");
    expect(configLine).toContain("built-in defaults");
  });

  it("shows a resolved config path with no benign note", () => {
    const out = renderLocations(report({ configPath: "/proj/agentrelay.config.json", configExists: true }));
    const configLine = out.split("\n").find((l) => l.includes("Config file:"));
    expect(configLine).toContain("/proj/agentrelay.config.json");
    expect(configLine).not.toContain("—"); // no note dash when it just exists
  });

  it("emits no ANSI codes when color is off", () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes leak.
    expect(renderLocations(report(), { color: false })).not.toMatch(/\x1b\[/);
  });

  it("emits ANSI codes when color is on", () => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting ANSI escapes are present.
    expect(renderLocations(report(), { color: true })).toMatch(/\x1b\[/);
  });
});

describe("renderLocationsJson", () => {
  it("produces valid JSON with generatedAt, storePath and the entries", () => {
    const parsed = JSON.parse(renderLocationsJson(report(), "2026-07-22T00:00:00.000Z"));
    expect(parsed.generatedAt).toBe("2026-07-22T00:00:00.000Z");
    expect(parsed.storePath).toBe(STORE);
    expect(parsed.entries.map((e: { kind: string }) => e.kind)).toEqual([
      "store",
      "store-dir",
      "config",
      "heartbeat",
      "backups",
    ]);
  });
});
