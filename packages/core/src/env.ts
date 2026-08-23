/**
 * Environment-variable capture and restore for resumed jobs.
 *
 * When `agentrelay run` wraps an agent CLI, the command frequently depends on
 * project-specific environment variables that live in *that* shell — a custom
 * `ANTHROPIC_BASE_URL`, an `HTTPS_PROXY`, extra `PATH` entries, a scoped API
 * token. The scheduler that resumes the job hours later runs inside the
 * *daemon's* process, which may have been started from an entirely different
 * shell and so carries a different environment. Anything the command relied on
 * is silently gone, and the resume behaves differently (or fails outright) for
 * reasons that never surface anywhere in the queue.
 *
 * These helpers let `run` capture an explicit, allow-listed set of variables
 * onto the job, and let the scheduler re-apply them (layered *over* the
 * daemon's own environment) when it spawns the resume. Everything here is pure
 * so it stays trivially testable and never reads `process.env` itself — the
 * caller passes the source environment in.
 */

/** A valid POSIX-ish environment-variable name (also fine on Windows). */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidEnvKey(key: string): boolean {
  return ENV_KEY_RE.test(key);
}

export interface EnvAssignment {
  key: string;
  value: string;
}

/** The persisted per-job environment map. Absent/empty means "inherit only". */
export type JobEnv = Record<string, string>;

/**
 * Parse a `KEY=VALUE` token as passed to `run --env`. Only the first `=`
 * splits, so the value may itself contain `=` (e.g. a base64 token or a URL
 * with a query string). Throws on a missing `=`, an empty key, or a key that
 * isn't a valid environment-variable identifier — so typos are caught at
 * enqueue time rather than silently producing a bogus variable on resume.
 */
export function parseEnvAssignment(token: string): EnvAssignment {
  const eq = token.indexOf("=");
  if (eq < 0) throw new Error(`Invalid --env "${token}": expected KEY=VALUE`);
  const key = token.slice(0, eq);
  const value = token.slice(eq + 1);
  if (!isValidEnvKey(key)) {
    throw new Error(`Invalid --env key "${key}": must match [A-Za-z_][A-Za-z0-9_]*`);
  }
  return { key, value };
}

/**
 * Capture the named variables from `source`, keeping only those that are
 * actually set. Used by `run --env-from NAME` to snapshot a variable from the
 * current shell *without echoing its value on the command line*. Unset names
 * are skipped (not stored as an empty string), and invalid names throw so a
 * typo is caught immediately.
 */
export function captureEnvFrom(names: string[], source: Record<string, string | undefined>): JobEnv {
  const out: JobEnv = {};
  for (const name of names) {
    if (!isValidEnvKey(name)) {
      throw new Error(`Invalid --env-from name "${name}": must match [A-Za-z_][A-Za-z0-9_]*`);
    }
    const value = source[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * Merge explicit `--env KEY=VALUE` assignments and `--env-from NAME` captures
 * into one job env map. An explicit assignment wins over a captured snapshot of
 * the same key (the user typed the value they want). Returns `undefined` when
 * nothing was captured, so the caller can leave the job's `env` field unset and
 * the scheduler keeps the plain-inheritance spawn path unchanged.
 */
export function buildJobEnv(assignments: EnvAssignment[], captured: JobEnv): JobEnv | undefined {
  const out: JobEnv = { ...captured };
  for (const { key, value } of assignments) out[key] = value;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Resolve the environment a resumed command should spawn with. The job's
 * captured variables are layered *over* the base environment (the daemon's
 * `process.env`), so the daemon's own `PATH` etc. remain the baseline and only
 * the explicitly captured keys are overridden. Returns `undefined` when the job
 * captured nothing, signalling the caller to spawn with plain inheritance (no
 * `env` option at all) — byte-for-byte the historical behavior, and what every
 * job created before this feature existed gets.
 */
export function resolveSpawnEnv(
  jobEnv: JobEnv | null | undefined,
  baseEnv: Record<string, string | undefined>
): Record<string, string | undefined> | undefined {
  if (!jobEnv || Object.keys(jobEnv).length === 0) return undefined;
  return { ...baseEnv, ...jobEnv };
}
