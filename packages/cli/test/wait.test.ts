import { describe, expect, it } from "vitest";
import { renderWaitAllJson } from "../src/wait.js";

const STORE = "/tmp/demo/jobs.json";
const AT = "2026-07-13T00:00:00.000Z";

describe("renderWaitAllJson", () => {
  it("emits the whole-queue drain envelope", () => {
    const json = renderWaitAllJson({ outcome: "drained", active: 0, exitCode: 0 }, STORE, AT);
    expect(JSON.parse(json)).toEqual({
      storePath: STORE,
      generatedAt: AT,
      mode: "all",
      outcome: "drained",
      exitCode: 0,
      active: 0,
    });
  });

  it("reports the still-active count on timeout", () => {
    const json = renderWaitAllJson({ outcome: "timeout", active: 3, exitCode: 124 }, STORE, AT);
    const parsed = JSON.parse(json);
    expect(parsed.outcome).toBe("timeout");
    expect(parsed.exitCode).toBe(124);
    expect(parsed.active).toBe(3);
  });
});
