import type { AgentTool, JobStatus, RelayJob } from "./types.js";

/**
 * Reading jobs *back into* the store — the inverse of the `export` family
 * ({@link ../export}). Where `export` turns the store into CSV/JSON/Markdown/
 * NDJSON for external analysis, `import` ingests the two *lossless* export
 * formats (JSON array and NDJSON) so a job history can be moved between
 * machines, merged from a teammate's snapshot, or reconstructed from an
 * archived dump. CSV/Markdown are deliberately not importable: they flatten
 * the `command` array and drop `lastOutputTail`, so round-tripping through them
 * would silently corrupt jobs.
 *
 * Everything here is pure (text/array in, validated jobs + a merge plan out) so
 * it's trivially testable and never touches the filesystem — the CLI/queue
 * layer owns reading bytes and mutating the store.
 */

/** Import source formats — the lossless subset of the export formats. */
export const IMPORT_FORMATS = ["json", "ndjson"] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

/** Narrowing guard for a caller-supplied `--format` string. */
export function isImportFormat(value: string): value is ImportFormat {
  return (IMPORT_FORMATS as readonly string[]).includes(value);
}

/**
 * Guess the import format from a file name's extension: `.ndjson` → `ndjson`,
 * `.json` → `json`. Case-insensitive. Returns null when the extension is
 * missing or unrecognized, so the CLI can ask the user to pass `--format`
 * rather than guessing wrong. (`.jsonl`, a common NDJSON alias, maps to
 * `ndjson` too.)
 */
export function inferImportFormat(fileName: string): ImportFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".ndjson") || lower.endsWith(".jsonl")) return "ndjson";
  if (lower.endsWith(".json")) return "json";
  return null;
}

// The valid membership sets a record must satisfy to be a well-formed job.
// JobStatus/AgentTool are hard-coded design decisions (see types.ts), so these
// literal lists are the authoritative runtime mirror used for validation.
const VALID_STATUSES: readonly JobStatus[] = [
  "queued",
  "waiting_for_reset",
  "resuming",
  "completed",
  "failed",
  "cancelled",
];
const VALID_TOOLS: readonly AgentTool[] = ["claude-code", "codex-cli", "generic"];

/** Statuses that mean "the relay is (or will be) actively working this job".
 *  Importing one of these makes the local scheduler start spawning the job's
 *  command, so they're excluded by default (history-only import). */
export const ACTIVE_IMPORT_STATUSES: readonly JobStatus[] = ["queued", "waiting_for_reset", "resuming"];

/** A record from the import source that couldn't be turned into a valid job. */
export interface ImportParseError {
  /** 1-based line number for NDJSON, or 0-based array index for JSON. */
  index: number;
  /** Which coordinate `index` refers to, so messages can read naturally. */
  kind: "line" | "index";
  /** Human-readable reason the record was rejected. */
  reason: string;
}

export interface ParsedImport {
  /** Records that validated into well-formed jobs, in source order. */
  jobs: RelayJob[];
  /** Records that failed structural validation (with why), in source order. */
  errors: ImportParseError[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Validate one decoded value as a {@link RelayJob}. Returns the (structurally
 * cloned) job on success or a rejection reason on failure. Strict on purpose —
 * an unknown `tool`/`status`, a non-array `command`, or a missing timestamp all
 * fail rather than being coerced, so a bad import can't seed the store with a
 * job the scheduler/renderers can't reason about. Unknown *extra* keys are
 * ignored (forward-compatible with future fields).
 */
export function validateJobRecord(value: unknown): { ok: true; job: RelayJob } | { ok: false; reason: string } {
  if (!isPlainObject(value)) return { ok: false, reason: "not a JSON object" };

  const requireString = (key: string): string | null =>
    typeof value[key] === "string" ? (value[key] as string) : null;
  const requireNullableString = (key: string): { ok: boolean; value: string | null } => {
    const v = value[key];
    if (v === null || v === undefined) return { ok: true, value: null };
    if (typeof v === "string") return { ok: true, value: v };
    return { ok: false, value: null };
  };

  const id = requireString("id");
  if (!id) return { ok: false, reason: "missing or non-string `id`" };

  const project = requireString("project");
  if (project === null) return { ok: false, reason: "missing or non-string `project`" };

  const tool = value.tool;
  if (typeof tool !== "string" || !VALID_TOOLS.includes(tool as AgentTool)) {
    return { ok: false, reason: `invalid \`tool\` (expected one of ${VALID_TOOLS.join(", ")})` };
  }

  if (!isStringArray(value.command)) return { ok: false, reason: "`command` must be an array of strings" };
  if (value.command.length === 0) return { ok: false, reason: "`command` must not be empty" };

  const cwd = requireString("cwd");
  if (cwd === null) return { ok: false, reason: "missing or non-string `cwd`" };

  const status = value.status;
  if (typeof status !== "string" || !VALID_STATUSES.includes(status as JobStatus)) {
    return { ok: false, reason: `invalid \`status\` (expected one of ${VALID_STATUSES.join(", ")})` };
  }

  const resetAt = requireNullableString("resetAt");
  if (!resetAt.ok) return { ok: false, reason: "`resetAt` must be a string or null" };

  const createdAt = requireString("createdAt");
  if (createdAt === null) return { ok: false, reason: "missing or non-string `createdAt`" };
  const updatedAt = requireString("updatedAt");
  if (updatedAt === null) return { ok: false, reason: "missing or non-string `updatedAt`" };

  const attempts = value.attempts;
  if (typeof attempts !== "number" || !Number.isInteger(attempts) || attempts < 0) {
    return { ok: false, reason: "`attempts` must be a non-negative integer" };
  }

  const lastError = requireNullableString("lastError");
  if (!lastError.ok) return { ok: false, reason: "`lastError` must be a string or null" };
  const lastOutputTail = requireNullableString("lastOutputTail");
  if (!lastOutputTail.ok) return { ok: false, reason: "`lastOutputTail` must be a string or null" };
  // Optional: preserved on export→import round-trips; absent in older dumps → null.
  const label = requireNullableString("label");
  if (!label.ok) return { ok: false, reason: "`label` must be a string or null" };

  return {
    ok: true,
    job: {
      id,
      project,
      tool: tool as AgentTool,
      command: [...value.command],
      cwd,
      label: label.value,
      status: status as JobStatus,
      resetAt: resetAt.value,
      createdAt,
      updatedAt,
      attempts,
      lastError: lastError.value,
      lastOutputTail: lastOutputTail.value,
    },
  };
}

/**
 * Parse import text into validated jobs plus per-record errors. For `json` the
 * whole payload must be a JSON array (matching `jobsToJson`); a parse failure or
 * non-array root yields a single error and no jobs. For `ndjson` each non-blank
 * line is parsed independently (matching `jobsToNdjson`), so one bad line
 * doesn't sink the rest — its error is recorded and parsing continues. Blank
 * lines are skipped. Never throws.
 */
export function parseImportJobs(text: string, format: ImportFormat): ParsedImport {
  const jobs: RelayJob[] = [];
  const errors: ImportParseError[] = [];

  if (format === "ndjson") {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      let decoded: unknown;
      try {
        decoded = JSON.parse(line);
      } catch (error) {
        errors.push({ index: i + 1, kind: "line", reason: `invalid JSON (${(error as Error).message})` });
        continue;
      }
      const result = validateJobRecord(decoded);
      if (result.ok) jobs.push(result.job);
      else errors.push({ index: i + 1, kind: "line", reason: result.reason });
    }
    return { jobs, errors };
  }

  // format === "json": the whole document is one JSON array of jobs.
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    errors.push({ index: 0, kind: "index", reason: `invalid JSON (${(error as Error).message})` });
    return { jobs, errors };
  }
  if (!Array.isArray(decoded)) {
    errors.push({ index: 0, kind: "index", reason: "root is not a JSON array of jobs" });
    return { jobs, errors };
  }
  for (let i = 0; i < decoded.length; i++) {
    const result = validateJobRecord(decoded[i]);
    if (result.ok) jobs.push(result.job);
    else errors.push({ index: i, kind: "index", reason: result.reason });
  }
  return { jobs, errors };
}

export interface ImportOptions {
  /**
   * Import jobs in an active status (queued/waiting_for_reset/resuming) too.
   * Off by default: an active job tells the local scheduler to start spawning
   * that job's command, which is almost never what you want when pulling in a
   * *history* dump from elsewhere. History-only (terminal states) is the safe
   * default; opt in with this flag to migrate a live queue between machines.
   */
  includeActive?: boolean;
  /**
   * Replace jobs whose `id` already exists in the store. Off by default —
   * existing jobs are left untouched and reported as skipped, so an import is
   * additive and can't silently overwrite local state. On, incoming records
   * win for colliding ids.
   */
  overwrite?: boolean;
}

/**
 * A resolved merge plan: exactly what an import would do to a store, computed
 * without mutating anything. The queue applies `toAdd` + `toUpdate`; the CLI's
 * `--dry-run` reports the whole plan and applies nothing.
 */
export interface ImportPlan {
  /** Incoming jobs whose id isn't in the store — inserted. */
  toAdd: RelayJob[];
  /** Incoming jobs whose id exists and that overwrite the current one (only when `overwrite`). */
  toUpdate: RelayJob[];
  /** Incoming jobs whose id exists but are left as-is (`overwrite` off). */
  skippedExisting: RelayJob[];
  /** Incoming active-status jobs excluded because `includeActive` is off. */
  skippedActive: RelayJob[];
}

/**
 * Compute an {@link ImportPlan} for merging `incoming` into `existing`. Pure and
 * order-preserving. Precedence per record: an active-status job is dropped first
 * (unless `includeActive`), then an id collision routes to `toUpdate`
 * (overwrite) or `skippedExisting`, else it's a fresh `toAdd`. When the incoming
 * set itself contains duplicate ids, the last one wins (later records overwrite
 * earlier within the batch) so the plan matches what a sequential apply would do.
 */
export function planImport(existing: RelayJob[], incoming: RelayJob[], options: ImportOptions = {}): ImportPlan {
  const includeActive = options.includeActive ?? false;
  const overwrite = options.overwrite ?? false;
  const existingIds = new Set(existing.map((job) => job.id));

  const plan: ImportPlan = { toAdd: [], toUpdate: [], skippedExisting: [], skippedActive: [] };
  // Track ids already claimed by an earlier accepted record in this batch so a
  // second occurrence is treated as "existing" (last-wins via overwrite path).
  const acceptedIds = new Set<string>();

  for (const job of incoming) {
    if (!includeActive && ACTIVE_IMPORT_STATUSES.includes(job.status)) {
      plan.skippedActive.push(job);
      continue;
    }
    const collides = existingIds.has(job.id) || acceptedIds.has(job.id);
    if (collides) {
      if (overwrite) {
        plan.toUpdate.push(job);
        acceptedIds.add(job.id);
      } else {
        plan.skippedExisting.push(job);
      }
    } else {
      plan.toAdd.push(job);
      acceptedIds.add(job.id);
    }
  }
  return plan;
}

/** Outcome counts from applying an import (or previewing one via dry-run). */
export interface ImportResult {
  /** New jobs inserted. */
  added: number;
  /** Existing jobs overwritten. */
  updated: number;
  /** Incoming jobs skipped because their id already existed (no overwrite). */
  skippedExisting: number;
  /** Incoming jobs skipped because they were active and `includeActive` was off. */
  skippedActive: number;
}

/** Collapse an {@link ImportPlan} into the flat counts callers report. */
export function summarizeImportPlan(plan: ImportPlan): ImportResult {
  return {
    added: plan.toAdd.length,
    updated: plan.toUpdate.length,
    skippedExisting: plan.skippedExisting.length,
    skippedActive: plan.skippedActive.length,
  };
}
