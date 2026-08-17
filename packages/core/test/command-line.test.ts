import { describe, expect, it } from "vitest";
import { tokenizeCommandLine } from "../src/command-line.js";

describe("tokenizeCommandLine", () => {
  it("splits a plain command on whitespace", () => {
    expect(tokenizeCommandLine("claude -p continue")).toEqual(["claude", "-p", "continue"]);
  });

  it("collapses runs of spaces, tabs, and newlines between tokens", () => {
    expect(tokenizeCommandLine("  claude\t-p\n continue  ")).toEqual(["claude", "-p", "continue"]);
  });

  it("returns an empty array for a blank string", () => {
    expect(tokenizeCommandLine("")).toEqual([]);
    expect(tokenizeCommandLine("   \t\n ")).toEqual([]);
  });

  it("keeps a double-quoted run as a single argument, spaces and all", () => {
    expect(tokenizeCommandLine('claude -p "continue the refactor"')).toEqual(["claude", "-p", "continue the refactor"]);
  });

  it("keeps a single-quoted run verbatim", () => {
    expect(tokenizeCommandLine("claude -p 'keep going'")).toEqual(["claude", "-p", "keep going"]);
  });

  it("treats single quotes literally inside double quotes and vice versa", () => {
    expect(tokenizeCommandLine('echo "it\'s fine"')).toEqual(["echo", "it's fine"]);
    expect(tokenizeCommandLine("echo 'a \"b\" c'")).toEqual(["echo", 'a "b" c']);
  });

  it("produces an empty argument for an empty quoted string", () => {
    expect(tokenizeCommandLine('a "" b')).toEqual(["a", "", "b"]);
    expect(tokenizeCommandLine("a '' b")).toEqual(["a", "", "b"]);
  });

  it("concatenates abutting quoted and bare fragments into one token", () => {
    expect(tokenizeCommandLine("a\"b\"'c'd")).toEqual(["abcd"]);
  });

  it("honours backslash escapes inside double quotes for quote and backslash only", () => {
    expect(tokenizeCommandLine('say "a\\"b"')).toEqual(["say", 'a"b']);
    expect(tokenizeCommandLine('path "c:\\\\tmp"')).toEqual(["path", "c:\\tmp"]);
  });

  it("does not process escapes inside single quotes (POSIX behaviour)", () => {
    expect(tokenizeCommandLine("say 'a\\b'")).toEqual(["say", "a\\b"]);
  });

  it("honours a bare backslash escape outside quotes", () => {
    expect(tokenizeCommandLine("a\\ b")).toEqual(["a b"]);
    expect(tokenizeCommandLine("a\\'b")).toEqual(["a'b"]);
  });

  it("throws on an unterminated double quote", () => {
    expect(() => tokenizeCommandLine('claude -p "oops')).toThrow(/unterminated double quote/);
  });

  it("throws on an unterminated single quote", () => {
    expect(() => tokenizeCommandLine("claude -p 'oops")).toThrow(/unterminated single quote/);
  });

  it("throws on a dangling trailing backslash", () => {
    expect(() => tokenizeCommandLine("claude -p continue\\")).toThrow(/dangling backslash/);
  });

  it("round-trips a realistic --resume-with value", () => {
    expect(tokenizeCommandLine('claude --continue -p "keep going on auth"')).toEqual([
      "claude",
      "--continue",
      "-p",
      "keep going on auth",
    ]);
  });
});
