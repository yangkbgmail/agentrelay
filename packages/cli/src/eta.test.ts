import type { ProjectEta, QueueEta } from "@agentrelay/core";
import { describe, expect, it } from "vitest";
import { NO_PROJECTS_WAITING_MESSAGE, renderEtaByProject, renderEtaJson } from "./eta.js";

/** Build a QueueEta for a project with `waiting` jobs caught up in `etaMs`. */
function eta(overrides: Partial<QueueEta> = {}): QueueEta {
  return {
    waiting: 2,
    dueNow: 0,
    firstResetAt: "2026-07-30T11:00:00.000Z",
    lastResetAt: "2026-07-30T13:00:00.000Z",
    etaMs: 3 * 60 * 60 * 1000,
    spanMs: 2 * 60 * 60 * 1000,
    caughtUp: false,
    ...overrides,
  };
}

function row(project: string, overrides: Partial<QueueEta> = {}): ProjectEta {
  return { project, eta: eta(overrides) };
}

describe("renderEtaByProject", () => {
  it("shows the caught-up message when no project is waiting", () => {
    expect(renderEtaByProject([])).toBe(NO_PROJECTS_WAITING_MESSAGE);
  });

  it("lists one line per project with its own countdown", () => {
    const out = renderEtaByProject([
      row("web", { etaMs: 60 * 60 * 1000 }),
      row("infra", { etaMs: 4 * 60 * 60 * 1000, waiting: 3 }),
    ]);
    expect(out).toContain("web");
    expect(out).toContain("infra");
    expect(out).toContain("in 1h");
    expect(out).toContain("in 4h");
  });

  it("phrases an all-due project as 'now (all due)'", () => {
    const out = renderEtaByProject([row("web", { etaMs: -1000, dueNow: 2 })]);
    expect(out).toContain("now (all due)");
    expect(out).toContain("2 due now");
  });

  it("summarises project and job totals in the footer", () => {
    const out = renderEtaByProject([row("web", { waiting: 2 }), row("infra", { waiting: 3 })]);
    expect(out).toContain("2 projects, 5 jobs waiting.");
  });

  it("uses singular nouns for a single project and job", () => {
    const out = renderEtaByProject([row("web", { waiting: 1 })]);
    expect(out).toContain("1 project, 1 job waiting.");
    expect(out).toContain("1 job)");
  });
});

describe("renderEtaJson", () => {
  const whole = eta();

  it("omits byProject when not requested", () => {
    const parsed = JSON.parse(renderEtaJson(whole, "/tmp/jobs.json", "2026-07-30T10:00:00.000Z"));
    expect(parsed).toHaveProperty("eta");
    expect(parsed).not.toHaveProperty("byProject");
    expect(parsed.storePath).toBe("/tmp/jobs.json");
  });

  it("includes byProject alongside the base eta when provided", () => {
    const parsed = JSON.parse(
      renderEtaJson(whole, "/tmp/jobs.json", "2026-07-30T10:00:00.000Z", [row("web"), row("infra")])
    );
    expect(parsed).toHaveProperty("eta");
    expect(parsed.byProject).toHaveLength(2);
    expect(parsed.byProject[0].project).toBe("web");
  });
});
