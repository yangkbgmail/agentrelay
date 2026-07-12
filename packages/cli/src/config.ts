import type { RetryPolicy } from "@agentrelay/core";

// Shared with the dashboard via @agentrelay/core so every entry point
// resolves the same store file.
export { defaultStorePath } from "@agentrelay/core";

/** Parse a positive-integer env var, ignoring blanks and invalid values. */
function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Retry policy overrides sourced from the environment, so the daemon/tick can
 * tune failure handling without code changes. Unset vars fall back to the
 * core defaults (DEFAULT_RETRY_POLICY).
 *   AGENTRELAY_MAX_ATTEMPTS     — max consecutive failures before giving up
 *   AGENTRELAY_BACKOFF_BASE_MS  — first backoff delay (doubles each failure)
 *   AGENTRELAY_BACKOFF_MAX_MS   — cap on the backoff delay
 */
export function retryPolicyFromEnv(): Partial<RetryPolicy> {
  const policy: Partial<RetryPolicy> = {};
  const maxAttempts = envInt("AGENTRELAY_MAX_ATTEMPTS");
  const base = envInt("AGENTRELAY_BACKOFF_BASE_MS");
  const max = envInt("AGENTRELAY_BACKOFF_MAX_MS");
  if (maxAttempts !== undefined) policy.maxAttempts = maxAttempts;
  if (base !== undefined) policy.baseBackoffMs = base;
  if (max !== undefined) policy.maxBackoffMs = max;
  return policy;
}

export function resolveProjectName(cwd: string): string {
  // Last path segment is good enough for a human-readable project label.
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}
