/**
 * Best-effort secret scrubber for captured agent output before it is persisted
 * to the job store (`jobs.json`) or handed out by `export`.
 *
 * The scheduler keeps the tail of an agent's combined stdout/stderr on every
 * completed or failed job so `agentrelay show` and the dashboard can explain
 * what happened (see `RelayJob.lastOutputTail`). Real agent output routinely
 * carries credentials — an `ANTHROPIC_API_KEY` echoed by a crashing script, a
 * `Authorization: Bearer …` line from a logged HTTP request, a git remote URL
 * with an embedded personal access token. Storing that verbatim quietly turns a
 * convenience log into a plaintext secret store on disk (and in any export a
 * user shares while asking for help).
 *
 * This scrubber recognizes the common, high-signal token shapes (provider API
 * keys, VCS tokens, cloud keys, `Authorization` bearer/token lines, and
 * `NAME=secret` / `NAME: secret` assignments for credential-looking names) and
 * replaces the secret material with {@link REDACTION_PLACEHOLDER}. It is
 * deliberately conservative: it leaves text it can't confidently classify
 * untouched, so it lowers exposure without mangling ordinary output. Pure —
 * string in, redacted string out, no I/O and no ambient state.
 *
 * It is a mitigation, not a guarantee: a novel secret format it doesn't know
 * can still slip through. Callers that must never persist output at all should
 * set `outputTailLength: 0` (or disable capture) rather than rely on this.
 */

import type { RelayJob } from "./types.js";

/** The token that replaces redacted secret material. */
export const REDACTION_PLACEHOLDER = "[REDACTED]";

type Replacement = string | ((match: string, ...groups: string[]) => string);

interface RedactionRule {
  /** Human-readable label for the class of secret (documentation/testing). */
  name: string;
  regex: RegExp;
  replacement: Replacement;
}

/**
 * Ordered redaction rules. Order matters where two patterns could touch the
 * same span: the provider-specific rules run before the generic `NAME=secret`
 * assignment sweep so a redacted value never gets double-processed in a way
 * that reveals structure. Every regex is global so all occurrences on a line
 * are caught, and case-insensitive where the surrounding wording varies.
 */
const RULES: RedactionRule[] = [
  {
    // Anthropic API keys. Keep the recognizable `sk-ant-` prefix so a scrubbed
    // log still says "an Anthropic key was here" without leaking the secret.
    name: "anthropic-key",
    regex: /sk-ant-[A-Za-z0-9_-]{16,}/g,
    replacement: `sk-ant-${REDACTION_PLACEHOLDER}`,
  },
  {
    // OpenAI-style keys (`sk-…`, `sk-proj-…`). Runs after the Anthropic rule so
    // an already-redacted `sk-ant-[REDACTED]` (the `[` ends the char class) is
    // never re-matched here.
    name: "openai-key",
    regex: /sk-(?:proj-)?[A-Za-z0-9]{16,}/g,
    replacement: `sk-${REDACTION_PLACEHOLDER}`,
  },
  {
    // GitHub tokens: personal (ghp), OAuth (gho), user-to-server (ghu),
    // server-to-server (ghs), and refresh (ghr) tokens.
    name: "github-token",
    regex: /gh[posur]_[A-Za-z0-9]{16,}/g,
    replacement: REDACTION_PLACEHOLDER,
  },
  {
    // GitHub fine-grained personal access tokens.
    name: "github-pat",
    regex: /github_pat_[A-Za-z0-9_]{20,}/g,
    replacement: REDACTION_PLACEHOLDER,
  },
  {
    // AWS access key ids.
    name: "aws-access-key-id",
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: REDACTION_PLACEHOLDER,
  },
  {
    // Slack tokens (bot/user/app/refresh/legacy).
    name: "slack-token",
    regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g,
    replacement: REDACTION_PLACEHOLDER,
  },
  {
    // Google API keys.
    name: "google-api-key",
    regex: /\bAIza[A-Za-z0-9_-]{35}\b/g,
    replacement: REDACTION_PLACEHOLDER,
  },
  {
    // `Authorization: Bearer <token>` / `Authorization: token <token>` — keep
    // the header name and scheme, redact only the credential that follows.
    name: "authorization-header",
    regex: /\b(authorization:\s*(?:bearer|token)\s+)\S+/gi,
    replacement: (_m, prefix) => `${prefix}${REDACTION_PLACEHOLDER}`,
  },
  {
    // `NAME=secret` / `NAME: secret` for credential-looking variable names
    // (…TOKEN, …SECRET, …PASSWORD/PASSWD, …API_KEY, …ACCESS_KEY, …PRIVATE_KEY).
    // Keeps the name so the log still shows *which* setting was present; the
    // value (quoted or bare) is replaced. Runs last so provider-specific rules
    // have already scrubbed recognizable values.
    name: "credential-assignment",
    regex:
      /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY)[A-Za-z0-9_]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
    replacement: (_m, prefix) => `${prefix}${REDACTION_PLACEHOLDER}`,
  },
];

/**
 * Redact secrets from `text`, returning a scrubbed copy. Empty/whitespace input
 * is returned unchanged. Pure and non-mutating.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const rule of RULES) {
    out =
      typeof rule.replacement === "string"
        ? out.replace(rule.regex, rule.replacement)
        : out.replace(rule.regex, rule.replacement);
  }
  return out;
}

/**
 * Resolve whether output-tail redaction is enabled from
 * `AGENTRELAY_REDACT_OUTPUT`. Secure by default: unset (or any value other than
 * an explicit off switch) → `true`. An explicit `0`/`off`/`false`/`no`/`none`
 * (case-insensitive) → `false`, for users who need the raw tail for debugging
 * and accept the exposure. A misspelled value does *not* silently disable
 * redaction — it stays on.
 */
export function redactOutputTailFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.AGENTRELAY_REDACT_OUTPUT?.trim();
  if (raw === undefined || raw === "") return true;
  return !/^(0|off|false|no|none|disabled)$/i.test(raw);
}

/**
 * A persisted free-text field on a job that can carry captured secret material.
 * The scheduler scrubs `lastOutputTail` at *write* time when redaction is on
 * (see {@link redactSecrets}), but jobs stored before that existed, imported
 * from an external dump, or hand-edited can still hold plaintext credentials —
 * and `lastError`/`lastRateLimit.rawMatch` are raw slices of agent output that
 * the write-time scrubber never touched. `agentrelay show`/`export` surface all
 * three, so a one-time sweep needs to reach every one.
 */
export type RedactableField = "lastOutputTail" | "lastError" | "rawMatch";

/** The free-text fields a store-wide redaction sweep scrubs, in job order. */
export const REDACTABLE_FIELDS: readonly RedactableField[] = ["lastOutputTail", "lastError", "rawMatch"];

/**
 * Scrub secrets from a single job's persisted free-text fields. Pure: returns a
 * new job (fields that don't change are shared by reference) plus which fields
 * were actually rewritten. `updatedAt` is intentionally left untouched —
 * redaction is a content cleanup, not a lifecycle transition, so it must not
 * perturb the created→updated span that stats/resolution-time read. When
 * nothing needs scrubbing the original job is returned unchanged with an empty
 * `changed` list.
 */
export function redactJob(job: RelayJob): { job: RelayJob; changed: RedactableField[] } {
  const changed: RedactableField[] = [];
  let next = job;

  if (job.lastOutputTail) {
    const scrubbed = redactSecrets(job.lastOutputTail);
    if (scrubbed !== job.lastOutputTail) {
      next = { ...next, lastOutputTail: scrubbed };
      changed.push("lastOutputTail");
    }
  }
  if (job.lastError) {
    const scrubbed = redactSecrets(job.lastError);
    if (scrubbed !== job.lastError) {
      next = { ...next, lastError: scrubbed };
      changed.push("lastError");
    }
  }
  if (job.lastRateLimit?.rawMatch) {
    const scrubbed = redactSecrets(job.lastRateLimit.rawMatch);
    if (scrubbed !== job.lastRateLimit.rawMatch) {
      next = { ...next, lastRateLimit: { ...job.lastRateLimit, rawMatch: scrubbed } };
      changed.push("rawMatch");
    }
  }

  return { job: next, changed };
}

/** One job that had at least one secret scrubbed by a store redaction sweep. */
export interface JobRedactionChange {
  id: string;
  project: string;
  /** Which free-text fields were rewritten, in {@link REDACTABLE_FIELDS} order. */
  fields: RedactableField[];
}

/** The result of planning (or applying) a store-wide redaction sweep. */
export interface StoreRedactionPlan {
  /** Per-job records for jobs that had at least one secret scrubbed, input order. */
  changes: JobRedactionChange[];
  /** Every job with redaction applied (unchanged jobs pass through by reference), input order. */
  jobs: RelayJob[];
  /** Total field rewrites across all jobs (≥ `changes.length`). */
  totalFields: number;
}

/**
 * Scrub secrets from a set of jobs, returning a new array of redacted jobs in
 * input order. Thin pure wrapper over {@link redactJob}: jobs that carry no
 * secret pass through by reference, so an all-clean set is returned essentially
 * untouched. Unlike {@link planStoreRedaction} (which also computes a per-job
 * change log for the in-place `redact` sweep), this returns only the jobs — the
 * shape `export --redact` needs, where redaction is a non-destructive transform
 * applied to a copy on the way out rather than a store mutation. Callers that
 * want the change log should use {@link planStoreRedaction} instead.
 */
export function redactJobs(jobs: RelayJob[]): RelayJob[] {
  return jobs.map((job) => redactJob(job).job);
}

/**
 * Compute a store-wide redaction plan: run {@link redactJob} over every job and
 * collect both the scrubbed job set and a per-job change log. Pure and
 * order-preserving — the queue applies `jobs` and the CLI's `--dry-run` reports
 * `changes` and writes nothing.
 */
export function planStoreRedaction(jobs: RelayJob[]): StoreRedactionPlan {
  const changes: JobRedactionChange[] = [];
  const out: RelayJob[] = [];
  let totalFields = 0;
  for (const job of jobs) {
    const { job: next, changed } = redactJob(job);
    out.push(next);
    if (changed.length > 0) {
      changes.push({ id: job.id, project: job.project, fields: changed });
      totalFields += changed.length;
    }
  }
  return { changes, jobs: out, totalFields };
}
