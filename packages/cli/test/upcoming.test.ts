import { buildResumeAgenda, type RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_MATCH_MESSAGE, NO_UPCOMING_MESSAGE, renderUpcoming, renderUpcomingJson } from "../src/upcoming.js";

const NOW = Date.parse("2026-07-13T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

let seq = 0;
function job(overrides: Partial<RelayJob> = {}): RelayJob {
  seq += 1;
  return {
    id: `abcdef${seq}234567890`,
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status: "waiting_for_reset",
    resetAt: at(30 * 60_000),
    createdAt: at(-1000),
    updatedAt: at(-1000),
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("renderUpcoming", () => {
  it("shows the empty message when nothing is waiting", () => {
    const agenda = buildResumeAgenda([], NOW);
    expect(renderUpcoming(agenda, { now: NOW })).toBe(NO_UPCOMING_MESSAGE);
  });

  it("shows the no-match message when a scope filter excludes everything", () => {
    const agenda = buildResumeAgenda([], NOW);
    expect(renderUpcoming(agenda, { now: NOW, scopeNote: "project=other" })).toBe(NO_MATCH_MESSAGE);
  });

  it("renders bucket headers with counts, and rows with id/project/tool/countdown/reset", () => {
    const jobs = [job({ id: "aaaa1111bbbb", resetAt: at(30 * 60_000), project: "api", tool: "codex-cli" })];
    const out = renderUpcoming(buildResumeAgenda(jobs, NOW), { now: NOW });
    expect(out).toContain("Within the hour  (1)");
    expect(out).toContain("aaaa1111");
    expect(out).toContain("api");
    expect(out).toContain("codex-cli");
    expect(out).toContain("30m");
    expect(out).toContain(at(30 * 60_000));
    expect(out).toContain("1 job waiting for a reset.");
  });

  it("says 'due now' for overdue jobs and pluralises the footer", () => {
    const jobs = [job({ resetAt: at(-HOUR) }), job({ resetAt: at(3 * HOUR) })];
    const out = renderUpcoming(buildResumeAgenda(jobs, NOW), { now: NOW });
    expect(out).toContain("Overdue (due now)  (1)");
    expect(out).toContain("due now");
    expect(out).toContain("2 jobs waiting for a reset.");
  });

  it("omits buckets that have no entries", () => {
    const jobs = [job({ resetAt: at(3 * HOUR) })];
    const out = renderUpcoming(buildResumeAgenda(jobs, NOW), { now: NOW });
    expect(out).toContain("Later today");
    expect(out).not.toContain("Overdue");
    expect(out).not.toContain("Within the hour");
    expect(out).not.toContain("Later (>");
  });

  it("prefixes the scope note when a filter is active", () => {
    const jobs = [job({ resetAt: at(3 * HOUR) })];
    const out = renderUpcoming(buildResumeAgenda(jobs, NOW), { now: NOW, scopeNote: "tool=claude-code" });
    expect(out).toContain("scope: tool=claude-code");
  });

  it("emits no ANSI codes when color is off", () => {
    const jobs = [job({ resetAt: at(-HOUR) }), job({ resetAt: at(3 * HOUR) })];
    const out = renderUpcoming(buildResumeAgenda(jobs, NOW), { now: NOW, color: false });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes leak.
    expect(out).not.toMatch(/\x1b\[/);
  });
});

describe("renderUpcomingJson", () => {
  it("produces valid JSON with the agenda, store path and generation stamp", () => {
    const agenda = buildResumeAgenda([job({ resetAt: at(30 * 60_000) })], NOW);
    const parsed = JSON.parse(
      renderUpcomingJson({ storePath: "/tmp/store.json", generatedAt: "2026-07-13T12:00:00.000Z", agenda })
    );
    expect(parsed.storePath).toBe("/tmp/store.json");
    expect(parsed.generatedAt).toBe("2026-07-13T12:00:00.000Z");
    expect(parsed.agenda.totalWaiting).toBe(1);
    expect(parsed.agenda.buckets.map((b: { key: string }) => b.key)).toEqual(["overdue", "hour", "today", "later"]);
    expect(parsed.scope).toBeUndefined();
  });

  it("echoes the active scope when present", () => {
    const agenda = buildResumeAgenda([], NOW);
    const parsed = JSON.parse(
      renderUpcomingJson({
        storePath: "/tmp/store.json",
        generatedAt: "2026-07-13T12:00:00.000Z",
        scope: { projects: ["api"] },
        agenda,
      })
    );
    expect(parsed.scope).toEqual({ projects: ["api"] });
  });
});
