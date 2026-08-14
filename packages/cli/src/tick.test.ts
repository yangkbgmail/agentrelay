import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planTick } from "./commands.js";

// Minimal valid RelayJob record — the JSON store's load() maps records by id
// without per-field validation, so a fixture with these fields round-trips.
function job(overrides: Record<string, unknown>) {
  return {
    id: "id",
    project: "proj",
    tool: "claude-code",
    command: ["claude", "-p", "continue"],
    cwd: "/tmp",
    status: "waiting_for_reset",
    resetAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    attempts: 0,
    lastError: null,
    lastOutputTail: null,
    ...overrides,
  };
}

describe("planTick (agentrelay tick --dry-run backing)", () => {
  let dir: string;
  let store: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentrelay-tick-dry-"));
    store = join(dir, "jobs.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const at = new Date("2026-06-01T12:00:00.000Z");
  const past = "2026-06-01T11:00:00.000Z"; // due
  const future = "2026-06-01T13:00:00.000Z"; // not yet due

  it("returns only waiting_for_reset jobs whose reset time has passed", () => {
    writeFileSync(
      store,
      JSON.stringify([
        job({ id: "due-1", project: "a", resetAt: past }),
        job({ id: "future-1", project: "b", resetAt: future }),
        job({ id: "running", project: "c", status: "resuming", resetAt: past }),
        job({ id: "done", project: "d", status: "completed", resetAt: past }),
      ])
    );

    const due = planTick(store, at);

    expect(due.map((j) => j.id)).toEqual(["due-1"]);
  });

  it("returns an empty list (nothing would resume) when no job is due", () => {
    writeFileSync(store, JSON.stringify([job({ id: "future-1", project: "b", resetAt: future })]));
    expect(planTick(store, at)).toEqual([]);
  });

  it("leaves the store file byte-for-byte untouched (dry run has no side effects)", () => {
    const contents = JSON.stringify([job({ id: "due-1", project: "a", resetAt: past })]);
    writeFileSync(store, contents);

    planTick(store, at);

    // A dry run must not resume, re-queue, or prune — the file is unchanged.
    expect(readFileSync(store, "utf8")).toBe(contents);
  });

  it("treats a missing store as an empty queue rather than erroring", () => {
    expect(planTick(join(dir, "does-not-exist.json"), at)).toEqual([]);
  });
});
