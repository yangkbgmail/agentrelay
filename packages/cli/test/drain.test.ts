import type { DrainState } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { renderDrainJson } from "../src/drain.js";

const state: DrainState = { active: 0, terminal: 3, failed: 1, total: 3, done: true };

describe("renderDrainJson", () => {
  it("produces valid JSON with storePath, outcome, exit code and state", () => {
    const parsed = JSON.parse(
      renderDrainJson(
        { outcome: "drained_with_failures", state, exitCode: 1 },
        "/tmp/store.json",
        "2026-07-31T00:00:00.000Z"
      )
    );
    expect(parsed.storePath).toBe("/tmp/store.json");
    expect(parsed.generatedAt).toBe("2026-07-31T00:00:00.000Z");
    expect(parsed.outcome).toBe("drained_with_failures");
    expect(parsed.exitCode).toBe(1);
    expect(parsed.state).toEqual(state);
  });
});
