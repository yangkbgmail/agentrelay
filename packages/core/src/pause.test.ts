import { describe, expect, it } from "vitest";
import { isPauseActive, PAUSE_FILENAME, parsePauseState, pauseFilePath, serializePauseState } from "./pause.js";

describe("pauseFilePath", () => {
  it("places the marker beside the store file", () => {
    expect(pauseFilePath("/home/u/.agentrelay/jobs.json")).toBe(`/home/u/.agentrelay/${PAUSE_FILENAME}`);
  });

  it("uses the store's directory even for a bare filename", () => {
    expect(pauseFilePath("jobs.json")).toBe(PAUSE_FILENAME);
  });
});

describe("serializePauseState / parsePauseState round-trip", () => {
  it("round-trips a state with a reason", () => {
    const state = { pausedAt: "2026-08-19T10:00:00.000Z", reason: "debugging auth" };
    expect(parsePauseState(serializePauseState(state))).toEqual(state);
  });

  it("round-trips a state without a reason", () => {
    const state = { pausedAt: "2026-08-19T10:00:00.000Z" };
    expect(parsePauseState(serializePauseState(state))).toEqual(state);
  });

  it("drops an empty/whitespace reason on serialize", () => {
    const json = serializePauseState({ pausedAt: "2026-08-19T10:00:00.000Z", reason: "   " });
    expect(JSON.parse(json)).toEqual({ pausedAt: "2026-08-19T10:00:00.000Z" });
  });

  it("emits pretty (2-space) JSON", () => {
    expect(serializePauseState({ pausedAt: "2026-08-19T10:00:00.000Z" })).toContain('\n  "pausedAt"');
  });
});

describe("parsePauseState tolerance", () => {
  it("returns null on non-JSON", () => {
    expect(parsePauseState("not json {{")).toBeNull();
  });

  it("returns null on a JSON array root", () => {
    expect(parsePauseState("[]")).toBeNull();
  });

  it("returns null on a JSON null", () => {
    expect(parsePauseState("null")).toBeNull();
  });

  it("returns null when pausedAt is missing", () => {
    expect(parsePauseState('{"reason":"x"}')).toBeNull();
  });

  it("returns null when pausedAt is empty", () => {
    expect(parsePauseState('{"pausedAt":""}')).toBeNull();
  });

  it("returns null when pausedAt is not a string", () => {
    expect(parsePauseState('{"pausedAt":123}')).toBeNull();
  });

  it("drops a non-string reason but keeps the pause", () => {
    expect(parsePauseState('{"pausedAt":"2026-08-19T10:00:00.000Z","reason":5}')).toEqual({
      pausedAt: "2026-08-19T10:00:00.000Z",
    });
  });

  it("ignores unknown extra keys (forward-compatible)", () => {
    expect(parsePauseState('{"pausedAt":"2026-08-19T10:00:00.000Z","future":true}')).toEqual({
      pausedAt: "2026-08-19T10:00:00.000Z",
    });
  });
});

describe("isPauseActive", () => {
  it("is true for a parsed state", () => {
    expect(isPauseActive({ pausedAt: "2026-08-19T10:00:00.000Z" })).toBe(true);
  });

  it("fails open (not paused) for null — a corrupt/absent marker can't wedge the queue", () => {
    expect(isPauseActive(null)).toBe(false);
  });
});
