import { describe, expect, it } from "vitest";
import { MAX_NOTE_LENGTH, normalizeNote } from "../src/notes.js";

describe("normalizeNote", () => {
  it("returns null for null/undefined", () => {
    expect(normalizeNote(null)).toBeNull();
    expect(normalizeNote(undefined)).toBeNull();
  });

  it("collapses empty/whitespace-only input to null (so it clears the note)", () => {
    expect(normalizeNote("")).toBeNull();
    expect(normalizeNote("   ")).toBeNull();
    expect(normalizeNote("\t\n ")).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeNote("  nightly refactor  ")).toBe("nightly refactor");
  });

  it("collapses interior whitespace/newlines to single spaces", () => {
    expect(normalizeNote("PR   #123\nCI\tfix")).toBe("PR #123 CI fix");
  });

  it("keeps a normal one-line note verbatim", () => {
    expect(normalizeNote("PR #123 CI fix")).toBe("PR #123 CI fix");
  });

  it("hard-caps overly long notes at MAX_NOTE_LENGTH", () => {
    const long = "x".repeat(MAX_NOTE_LENGTH + 50);
    const result = normalizeNote(long);
    expect(result).not.toBeNull();
    expect(result?.length).toBe(MAX_NOTE_LENGTH);
  });

  it("does not truncate a note exactly at the cap", () => {
    const exact = "y".repeat(MAX_NOTE_LENGTH);
    expect(normalizeNote(exact)).toBe(exact);
  });
});
