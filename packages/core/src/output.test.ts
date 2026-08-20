import { describe, expect, it } from "vitest";
import {
  createOutputTail,
  DEFAULT_OUTPUT_TAIL_LENGTH,
  outputTailLengthFromEnv,
  parseOutputTailLength,
} from "./output.js";

describe("createOutputTail", () => {
  it("returns everything appended when the total stays under the cap", () => {
    const tail = createOutputTail(100);
    tail.append("hello ");
    tail.append("world");
    expect(tail.snapshot()).toBe("hello world");
    expect(tail.maxChars).toBe(100);
  });

  it("keeps only the last maxChars characters across many appends", () => {
    const tail = createOutputTail(5);
    tail.append("abc");
    tail.append("de");
    tail.append("fg");
    expect(tail.snapshot()).toBe("cdefg");
    // append() returns the current snapshot for callers that want it inline
    expect(tail.append("hi")).toBe("efghi");
  });

  it("handles a single chunk that already exceeds the cap without allocating the full string", () => {
    const tail = createOutputTail(10);
    // 1 MB of a single char — the fast path must not concatenate before slicing.
    const big = "x".repeat(1_000_000);
    tail.append(big);
    expect(tail.snapshot()).toBe("x".repeat(10));
    expect(tail.snapshot().length).toBe(10);
  });

  it("stays bounded no matter how many chunks stream through (memory safety regression)", () => {
    const tail = createOutputTail(64);
    for (let i = 0; i < 10_000; i++) {
      tail.append("garbage garbage garbage garbage garbage garbage");
    }
    tail.append("<<END>>");
    expect(tail.snapshot().length).toBeLessThanOrEqual(64);
    // Freshest content wins the tail slot.
    expect(tail.snapshot().endsWith("<<END>>")).toBe(true);
  });

  it("preserves order across many small chunks (tail must be freshest)", () => {
    const tail = createOutputTail(4);
    for (const c of ["a", "b", "c", "d", "e", "f"]) tail.append(c);
    expect(tail.snapshot()).toBe("cdef");
  });

  it("with maxChars <= 0 disables buffering but still accepts appends", () => {
    const tail = createOutputTail(0);
    tail.append("anything");
    expect(tail.snapshot()).toBe("");
    expect(tail.maxChars).toBe(0);
    const negative = createOutputTail(-42);
    negative.append("also nothing");
    expect(negative.snapshot()).toBe("");
    expect(negative.maxChars).toBe(0);
  });

  it("treats non-finite maxChars as disabled (never crash the relay loop)", () => {
    const tail = createOutputTail(Number.NaN);
    tail.append("nothing keeps");
    expect(tail.snapshot()).toBe("");
    const tail2 = createOutputTail(Number.POSITIVE_INFINITY);
    // Infinity is not > 0? It is — but not finite, so we treat it as misconfig
    // and disable buffering rather than crash if it later coerces oddly.
    tail2.append("also nothing");
    expect(tail2.snapshot()).toBe("");
  });

  it("uses DEFAULT_OUTPUT_TAIL_LENGTH when constructed with no argument", () => {
    const tail = createOutputTail();
    expect(tail.maxChars).toBe(DEFAULT_OUTPUT_TAIL_LENGTH);
    tail.append("x".repeat(DEFAULT_OUTPUT_TAIL_LENGTH + 500));
    expect(tail.snapshot().length).toBe(DEFAULT_OUTPUT_TAIL_LENGTH);
  });
});

describe("parseOutputTailLength", () => {
  it("returns the default for undefined, null, blank, or missing input", () => {
    expect(parseOutputTailLength(undefined)).toBe(DEFAULT_OUTPUT_TAIL_LENGTH);
    expect(parseOutputTailLength(null)).toBe(DEFAULT_OUTPUT_TAIL_LENGTH);
    expect(parseOutputTailLength("")).toBe(DEFAULT_OUTPUT_TAIL_LENGTH);
    expect(parseOutputTailLength("   ")).toBe(DEFAULT_OUTPUT_TAIL_LENGTH);
  });

  it("parses plain numeric strings and finite numbers", () => {
    expect(parseOutputTailLength("500")).toBe(500);
    expect(parseOutputTailLength(500)).toBe(500);
    expect(parseOutputTailLength("  2000  ")).toBe(2000);
  });

  it("floors decimals so '2000.9' reads as 2000", () => {
    expect(parseOutputTailLength("2000.9")).toBe(2000);
    expect(parseOutputTailLength(2000.9)).toBe(2000);
  });

  it("preserves 0 exactly (an explicit request to disable buffering)", () => {
    expect(parseOutputTailLength("0")).toBe(0);
    expect(parseOutputTailLength(0)).toBe(0);
  });

  it("falls back to the default for typos, negatives, NaN, and Infinity — no silent-disable footgun", () => {
    expect(parseOutputTailLength("abc")).toBe(DEFAULT_OUTPUT_TAIL_LENGTH);
    expect(parseOutputTailLength("-1")).toBe(DEFAULT_OUTPUT_TAIL_LENGTH);
    expect(parseOutputTailLength(-1)).toBe(DEFAULT_OUTPUT_TAIL_LENGTH);
    expect(parseOutputTailLength(Number.NaN)).toBe(DEFAULT_OUTPUT_TAIL_LENGTH);
    expect(parseOutputTailLength(Number.POSITIVE_INFINITY)).toBe(DEFAULT_OUTPUT_TAIL_LENGTH);
    expect(parseOutputTailLength("1e309")).toBe(DEFAULT_OUTPUT_TAIL_LENGTH); // parses to Infinity
  });

  it("honours a custom defaultValue when supplied", () => {
    expect(parseOutputTailLength(undefined, { defaultValue: 42 })).toBe(42);
    expect(parseOutputTailLength("nope", { defaultValue: 42 })).toBe(42);
  });
});

describe("outputTailLengthFromEnv", () => {
  it("returns the default when AGENTRELAY_OUTPUT_TAIL is unset", () => {
    expect(outputTailLengthFromEnv({})).toBe(DEFAULT_OUTPUT_TAIL_LENGTH);
    expect(outputTailLengthFromEnv({ SOMETHING_ELSE: "500" })).toBe(DEFAULT_OUTPUT_TAIL_LENGTH);
  });

  it("reads a valid override from AGENTRELAY_OUTPUT_TAIL", () => {
    expect(outputTailLengthFromEnv({ AGENTRELAY_OUTPUT_TAIL: "500" })).toBe(500);
    expect(outputTailLengthFromEnv({ AGENTRELAY_OUTPUT_TAIL: "10000" })).toBe(10000);
  });

  it("falls back to the default on a garbled AGENTRELAY_OUTPUT_TAIL (typo must not silently break parsing)", () => {
    expect(outputTailLengthFromEnv({ AGENTRELAY_OUTPUT_TAIL: "abc" })).toBe(DEFAULT_OUTPUT_TAIL_LENGTH);
    expect(outputTailLengthFromEnv({ AGENTRELAY_OUTPUT_TAIL: "-1" })).toBe(DEFAULT_OUTPUT_TAIL_LENGTH);
    expect(outputTailLengthFromEnv({ AGENTRELAY_OUTPUT_TAIL: "   " })).toBe(DEFAULT_OUTPUT_TAIL_LENGTH);
  });

  it("accepts an explicit 0 to disable buffering (advanced/tests)", () => {
    expect(outputTailLengthFromEnv({ AGENTRELAY_OUTPUT_TAIL: "0" })).toBe(0);
  });
});
