// Pure diagnostics for `agentrelay doctor`. Given a snapshot of the effective
// environment (Node version, store file, config discovery, notifiers, retry
// policy), produce a list of checks with a severity each. All I/O — reading the
// Node version, probing the filesystem, loading the config — is done by the
// caller and passed in, so this logic is deterministic and unit-testable
// without a real environment.

import type { RetryPolicy } from "./types.js";

/** Minimum Node.js version AgentRelay targets (see CLAUDE.md — Node >= 22.5). */
export const MIN_NODE_VERSION = "22.5.0";

export type CheckStatus = "ok" | "warn" | "error";

export interface DoctorCheck {
  /** Short stable identifier, e.g. "node", "store", "config". */
  name: string;
  status: CheckStatus;
  /** Human-readable one-line explanation. */
  detail: string;
}

/** Filesystem-level facts about the job store, gathered by the caller. */
export interface DoctorStoreInfo {
  path: string;
  /** Does the store file already exist? */
  exists: boolean;
  /** Can the relay create/replace the file (parent dir or file writable)? */
  writable: boolean;
  /** Parsed job count, or null when the file is absent/unreadable. */
  jobCount: number | null;
  /** Non-null when the existing file could not be parsed as the expected JSON. */
  parseError: string | null;
}

/** Config-file discovery facts, gathered by the caller. */
export interface DoctorConfigInfo {
  /** Resolved config path, or null when no file was found. */
  path: string | null;
  /** Non-null when a named config file failed to load/parse. */
  error: string | null;
}

export interface DoctorInput {
  /** Running Node version, e.g. `process.versions.node` ("22.5.0"). */
  nodeVersion: string;
  /** Minimum required version; defaults to {@link MIN_NODE_VERSION}. */
  minNodeVersion?: string;
  store: DoctorStoreInfo;
  config: DoctorConfigInfo;
  /** Which remote notifiers are configured (from env/config). */
  notifiers: { slack: boolean; webhook: boolean };
  /** Effective retry policy. */
  retry: RetryPolicy;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** True when no check has "error" status (warnings are tolerated). */
  ok: boolean;
}

/**
 * Parses a version like `22.5.0`, `v22.5.0`, or `22.5.0-nightly` into a
 * `[major, minor, patch]` tuple. Missing or non-numeric segments become 0, so
 * partial strings (`"22"`, `"22.5"`) still compare sensibly.
 */
export function parseVersion(version: string): [number, number, number] {
  const cleaned = version.trim().replace(/^v/i, "");
  // Drop any pre-release/build suffix (`-nightly`, `+meta`) before splitting.
  const core = cleaned.split(/[-+]/)[0];
  const parts = core.split(".");
  const num = (i: number) => {
    const n = Number.parseInt(parts[i] ?? "0", 10);
    return Number.isFinite(n) ? n : 0;
  };
  return [num(0), num(1), num(2)];
}

/** Compares two version strings: <0 if a<b, 0 if equal, >0 if a>b. */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) return va[i] - vb[i];
  }
  return 0;
}

/**
 * Turns an environment snapshot into a diagnostics report. Each subsystem
 * contributes exactly one check; the overall `ok` is true unless any check is
 * an "error" (warnings, e.g. no notifiers, don't fail the doctor).
 */
export function runDoctorChecks(input: DoctorInput): DoctorReport {
  const checks: DoctorCheck[] = [];
  const min = input.minNodeVersion ?? MIN_NODE_VERSION;

  // 1. Node version — the one hard runtime requirement.
  if (compareVersions(input.nodeVersion, min) < 0) {
    checks.push({
      name: "node",
      status: "error",
      detail: `Node ${input.nodeVersion} is below the required ${min}. Please upgrade Node.`,
    });
  } else {
    checks.push({ name: "node", status: "ok", detail: `Node ${input.nodeVersion} (>= ${min})` });
  }

  // 2. Store file — must be readable (if present) and writable so jobs persist.
  const store = input.store;
  if (store.parseError !== null) {
    checks.push({
      name: "store",
      status: "error",
      detail: `Store file at ${store.path} is not valid JSON: ${store.parseError}`,
    });
  } else if (!store.writable) {
    checks.push({
      name: "store",
      status: "error",
      detail: `Store path ${store.path} is not writable — the relay cannot persist jobs here.`,
    });
  } else if (!store.exists) {
    checks.push({
      name: "store",
      status: "ok",
      detail: `Store ${store.path} does not exist yet; it will be created on first run.`,
    });
  } else {
    const n = store.jobCount ?? 0;
    checks.push({ name: "store", status: "ok", detail: `Store ${store.path} readable (${n} job(s))` });
  }

  // 3. Config file — optional, but a named-yet-broken one is a hard error.
  const config = input.config;
  if (config.error !== null) {
    checks.push({ name: "config", status: "error", detail: `Config error: ${config.error}` });
  } else if (config.path !== null) {
    checks.push({ name: "config", status: "ok", detail: `Config loaded from ${config.path}` });
  } else {
    checks.push({
      name: "config",
      status: "ok",
      detail: "No config file found; using built-in defaults and AGENTRELAY_* env vars.",
    });
  }

  // 4. Notifiers — optional, so their absence is only a warning.
  const enabled = [input.notifiers.slack ? "slack" : null, input.notifiers.webhook ? "webhook" : null].filter(
    (x): x is string => x !== null
  );
  if (enabled.length > 0) {
    checks.push({ name: "notifiers", status: "ok", detail: `Configured: ${enabled.join(", ")}` });
  } else {
    checks.push({
      name: "notifiers",
      status: "warn",
      detail: "No notifiers configured — you won't be alerted when jobs resume or fail. (Optional.)",
    });
  }

  // 5. Retry policy — display the effective policy, flag any incoherent values.
  const r = input.retry;
  const issues: string[] = [];
  if (r.maxAttempts < 0) issues.push("maxAttempts is negative");
  if (r.baseDelayMs <= 0) issues.push("baseDelayMs must be > 0");
  if (r.factor < 1) issues.push("factor should be >= 1");
  if (r.maxDelayMs < r.baseDelayMs) issues.push("maxDelayMs is below baseDelayMs");
  if (issues.length > 0) {
    checks.push({ name: "retry", status: "warn", detail: `Retry policy: ${issues.join("; ")}.` });
  } else {
    const cap = r.maxAttempts === 0 ? "unlimited attempts" : `${r.maxAttempts} attempts`;
    checks.push({
      name: "retry",
      status: "ok",
      detail: `Retry: ${cap}, backoff ${r.baseDelayMs}ms x${r.factor} up to ${r.maxDelayMs}ms.`,
    });
  }

  const ok = checks.every((c) => c.status !== "error");
  return { checks, ok };
}
