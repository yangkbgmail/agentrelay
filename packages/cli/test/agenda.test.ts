import { computeResumeAgenda, type RelayJob } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_AGENDA_MESSAGE, renderAgenda, renderAgendaJson } from "../src/agenda.js";

const NOW = Date.parse("2026-07-24T10:00:00.000Z");

function job(overrides: Partial<RelayJob> = {}): RelayJob {
  return {
    id: "abcdef1234567890",
    project: "demo",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp/demo",
    status: "waiting_for_reset",
    resetAt: new Date(NOW + 5 * 60_000).toISOString(),
    createdAt: new Date(NOW - 60_000).toISOString(),
    updatedAt: new Date(NOW - 60_000).toISOString(),
    attempts: 1,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

function waiting(mins: number, overrides: Partial<RelayJob> = {}): RelayJob {
  return job({ id: `job-${mins}`, resetAt: new Date(NOW + mins * 60_000).toISOString(), ...overrides });
}

describe("renderAgenda", () => {
  it("shows the empty message when nothing is waiting", () => {
    const agenda = computeResumeAgenda([], { now: NOW });
    expect(renderAgenda(agenda, { now: NOW })).toBe(NO_AGENDA_MESSAGE);
  });

  it("shows a header with the waiting total and per-window job lines", () => {
    const agenda = computeResumeAgenda([waiting(5, { project: "web" })], { now: NOW });
    const out = renderAgenda(agenda, { now: NOW });
    expect(out).toContain("Resume agenda");
    expect(out).toContain("1 job waiting");
    expect(out).toContain("in 5m");
    expect(out).toContain("web");
    expect(out).toContain("(claude-code)");
  });

  it("marks a crowded window as a herd", () => {
    const agenda = computeResumeAgenda([waiting(5), waiting(5.5), waiting(5.9)], { now: NOW });
    const out = renderAgenda(agenda, { now: NOW });
    expect(out).toContain("3 jobs");
    expect(out).toContain("(herd)");
  });

  it("does not mark a single-job window as a herd", () => {
    const agenda = computeResumeAgenda([waiting(5)], { now: NOW });
    expect(renderAgenda(agenda, { now: NOW })).not.toContain("(herd)");
  });

  it("labels the due-now bucket and counts it in the header", () => {
    const agenda = computeResumeAgenda([waiting(-3), waiting(5)], { now: NOW });
    const out = renderAgenda(agenda, { now: NOW });
    expect(out).toContain("due now");
    expect(out).toContain("1 due now");
  });

  it("notes the hidden tail when windows were limited", () => {
    const agenda = computeResumeAgenda([waiting(1), waiting(10), waiting(20)], { now: NOW, limit: 1 });
    const out = renderAgenda(agenda, { now: NOW });
    expect(out).toContain("2 more window(s)");
    expect(out).toContain("not shown");
  });

  it("adds a scope note when provided", () => {
    const agenda = computeResumeAgenda([waiting(5)], { now: NOW });
    expect(renderAgenda(agenda, { now: NOW, scopeNote: "project=web" })).toContain("[scope: project=web]");
  });

  it("emits no ANSI codes when color is off", () => {
    const agenda = computeResumeAgenda([waiting(5), waiting(5.5)], { now: NOW });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no ANSI escapes leak.
    expect(renderAgenda(agenda, { now: NOW, color: false })).not.toMatch(/\x1b\[/);
  });
});

describe("renderAgendaJson", () => {
  it("produces valid JSON with storePath, generatedAt, and the agenda", () => {
    const agenda = computeResumeAgenda([waiting(5)], { now: NOW });
    const parsed = JSON.parse(renderAgendaJson(agenda, "/tmp/store.json", { generatedAt: "2026-07-24T10:00:00.000Z" }));
    expect(parsed.storePath).toBe("/tmp/store.json");
    expect(parsed.generatedAt).toBe("2026-07-24T10:00:00.000Z");
    expect(parsed.agenda.totalWaiting).toBe(1);
    expect(parsed.agenda.windows).toHaveLength(1);
  });

  it("echoes the active scope when given", () => {
    const agenda = computeResumeAgenda([waiting(5)], { now: NOW });
    const parsed = JSON.parse(renderAgendaJson(agenda, "/tmp/store.json", { scope: { projects: ["web"] } }));
    expect(parsed.scope).toEqual({ projects: ["web"] });
  });
});
