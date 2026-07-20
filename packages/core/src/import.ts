import type { AgentTool, JobStatus, RelayJob } from "./types.js";

/**
 * The inverse of `export` (see {@link exportJobs}): read a previously exported
 * job history back into a store. Where `export` hands out one row per job for
 * spreadsheets/BI, `import` takes the lossless serializations back and merges
 * them into the current store — useful for moving history between machines,
 * seeding a fresh install, or recovering from an out-of-band `jobs.json` copy.
 *
 * Only the *lossless* export formats round-trip: JSON (an array of jobs) and
 * NDJSON (one job per line). CSV/Markdown are deliberately lossy (the `command`
 * array is space-joined and `lastOutputTail` is dropped), so importing them
 * couldn't faithfully reconstruct a job — they're export-only.
 *
 * Everything here is pure (text in, jobs/plan out) so it's trivially testable
 * and never touches the filesystem — the CLI/queue layer decides what to do
 * with the parsed jobs.
 */

/** Import formats — the lossless subset of the export formats. */
export const IMPORT_FORMATS = ["json", "ndjson"] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

/**
 * How to resolve an id collision when merging imported jobs into an existing
 * store:
 * - `skip` (default): keep the existing job, ignore the incoming one. Safe —
 *   an import never clobbers live state.
 * - `overwrite`: replace the existing job with the incoming one. For migrating
 *   an authoritative history onto a machine whose store is stale/empty.
 */
export const IMPORT_STRATEGIES = ["skip", "overwrite"] as const;
export type ImportStrategy = (typeof IMPORT_STRATEGIES)[number];

const VALID_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "queued",
  "waiting_for_reset",
  "resuming",
  "completed",
  "failed",
  "cancelled",
]);

const VALID_TOOLS: ReadonlySet<AgentTool> = new Set<AgentTool>(["claude-code", "codex-cli", "generic"]);

/** A record that couldn't be accepted as a valid {@link RelayJob}, with why. */
export interface ImportRecordError {
  /** 0-based position of the offending record in the source (array index / NDJSON line). */
  index: number;
  /** Human-readable reason the record was rejected. */
  message: string;
}

/** Result of parsing import content: the valid jobs plus per-record errors. */
export interface ParseImportResult {
  jobs: RelayJob[];
  errors: ImportRecordError[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Validate that an arbitrary parsed value is a well-formed {@link RelayJob}.
 * Returns `null` when it is, or a reason string when it isn't. Strict enough
 * that a malformed record can't slip into the store and confuse the scheduler
 * (e.g. a missing `status` or a non-array `command`), but it only checks shape —
 * it doesn't invent defaults, so an import faithfully reflects the source.
 */
export function validateJobRecord(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "not a JSON object";
  }
  const job = value as Record<string, unknown>;

  if (!isNonEmptyString(job.id)) return "missing or empty `id`";
  if (typeof job.project !== "string") return "`project` must be a string";
  if (!VALID_TOOLS.has(job.tool as AgentTool)) {
    return `\`tool\` must be one of ${[...VALID_TOOLS].join(", ")}`;
  }
  if (!Array.isArray(job.command) || !job.command.every((c) => typeof c === "string")) {
    return "`command` must be an array of strings";
  }
  if (typeof job.cwd !== "string") return "`cwd` must be a string";
  if (!VALID_STATUSES.has(job.status as JobStatus)) {
    return `\`status\` must be one of ${[...VALID_STATUSES].join(", ")}`;
  }
  if (job.resetAt !== null && typeof job.resetAt !== "string") return "`resetAt` must be a string or null";
  if (typeof job.createdAt !== "string") return "`createdAt` must be a string";
  if (typeof job.updatedAt !== "string") return "`updatedAt` must be a string";
  if (typeof job.attempts !== "number" || !Number.isFinite(job.attempts)) {
    return "`attempts` must be a finite number";
  }
  if (job.lastError !== null && typeof job.lastError !== "string") return "`lastError` must be a string or null";
  if (job.lastOutputTail !== null && typeof job.lastOutputTail !== "string") {
    return "`lastOutputTail` must be a string or null";
  }
  return null;
}

/** Coerce a validated record into a clean {@link RelayJob} (only known fields). */
function toJob(value: Record<string, unknown>): RelayJob {
  return {
    id: value.id as string,
    project: value.project as string,
    tool: value.tool as AgentTool,
    command: value.command as string[],
    cwd: value.cwd as string,
    status: value.status as JobStatus,
    resetAt: (value.resetAt as string | null) ?? null,
    createdAt: value.createdAt as string,
    updatedAt: value.updatedAt as string,
    attempts: value.attempts as number,
    lastError: (value.lastError as string | null) ?? null,
    lastOutputTail: (value.lastOutputTail as string | null) ?? null,
  };
}

/**
 * Parse import content in the given format into valid jobs + per-record errors.
 *
 * Validation is *per record*, not all-or-nothing: one malformed job (or one bad
 * NDJSON line) is collected as an error and skipped rather than aborting the
 * whole import, so a mostly-good file still imports its good rows. A structural
 * failure that means nothing can be parsed — invalid top-level JSON, or a JSON
 * root that isn't an array — throws, since there's no partial result to salvage.
 * Blank NDJSON lines are ignored (trailing newline tolerance).
 */
export function parseImportContent(content: string, format: ImportFormat): ParseImportResult {
  const jobs: RelayJob[] = [];
  const errors: ImportRecordError[] = [];

  if (format === "ndjson") {
    const lines = content.split(/\r?\n/);
    let index = -1;
    for (const line of lines) {
      if (!line.trim()) continue; // tolerate blank/trailing lines
      index += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        errors.push({ index, message: `invalid JSON: ${(error as Error).message}` });
        continue;
      }
      const reason = validateJobRecord(parsed);
      if (reason) {
        errors.push({ index, message: reason });
        continue;
      }
      jobs.push(toJob(parsed as Record<string, unknown>));
    }
    return { jobs, errors };
  }

  // JSON: the whole document must parse and be an array of records.
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`invalid JSON: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("JSON import must be an array of job records");
  }
  parsed.forEach((record, index) => {
    const reason = validateJobRecord(record);
    if (reason) {
      errors.push({ index, message: reason });
      return;
    }
    jobs.push(toJob(record as Record<string, unknown>));
  });
  return { jobs, errors };
}

/**
 * The outcome of merging `incoming` jobs into `existing` under a strategy,
 * computed purely so both the queue write and a `--dry-run` preview share the
 * exact same logic.
 */
export interface ImportPlan {
  /** The full job set after the merge (existing + accepted incoming). */
  merged: RelayJob[];
  /** Incoming jobs whose id wasn't in the store — newly added. */
  added: RelayJob[];
  /** Incoming jobs that replaced an existing id (only under `overwrite`). */
  updated: RelayJob[];
  /** Incoming jobs whose id already existed and were left untouched (`skip`). */
  skipped: RelayJob[];
}

/**
 * Plan how `incoming` jobs merge into `existing` under `strategy`, without
 * mutating either input. New ids are always added; a colliding id is either
 * left alone (`skip`) or replaced (`overwrite`). If `incoming` itself contains
 * duplicate ids, the *last* one wins (mirrors how a Map load would resolve them),
 * and the collision is classified against the store's original contents.
 */
export function planImport(existing: RelayJob[], incoming: RelayJob[], strategy: ImportStrategy = "skip"): ImportPlan {
  const merged = new Map(existing.map((job) => [job.id, job]));
  const existedBefore = new Set(existing.map((job) => job.id));
  const added: RelayJob[] = [];
  const updated: RelayJob[] = [];
  const skipped: RelayJob[] = [];

  for (const job of incoming) {
    if (!existedBefore.has(job.id)) {
      // Brand-new id (relative to the original store). Always added; a later
      // duplicate in `incoming` just refreshes the pending value.
      merged.set(job.id, job);
      const priorAddIndex = added.findIndex((a) => a.id === job.id);
      if (priorAddIndex >= 0) added[priorAddIndex] = job;
      else added.push(job);
      continue;
    }
    if (strategy === "overwrite") {
      merged.set(job.id, job);
      const priorIndex = updated.findIndex((u) => u.id === job.id);
      if (priorIndex >= 0) updated[priorIndex] = job;
      else updated.push(job);
    } else {
      skipped.push(job);
    }
  }

  return { merged: Array.from(merged.values()), added, updated, skipped };
}
