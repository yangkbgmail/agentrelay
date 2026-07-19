import type { ConfigIssue } from "./config.js";
import type { RelayJob } from "./types.js";

/**
 * Health-check diagnostics for `agentrelay doctor`.
 *
 * The point of a local-first CLI is that "it just works" on the user's own
 * machine — but a mis-set env var, an unsupported Node, or a store file that got
 * corrupted can silently break the relay loop. `doctor` gathers the facts that
 * matter and reports them as a flat list of pass/warn/fail checks so a user can
 * confirm their setup in one command instead of guessing.
 *
 * The gathering (reading the store, resolving the config file, inspecting the
 * environment) lives in the CLI where the filesystem is; this module is the
 * *pure* judgement layer — it takes already-collected facts and decides what's
 * healthy. That keeps every rule unit-testable without touching disk or env.
 */

/** Severity of a single {@link DiagnosticCheck}. Errors fail the report. */
export type DiagnosticLevel = "ok" | "warning" | "error";

/** One thing `doctor` looked at, with a verdict and (for problems) a fix hint. */
export interface DiagnosticCheck {
  /** Stable short id, e.g. `node-version` — usable as a machine key. */
  name: string;
  level: DiagnosticLevel;
  /** Human-readable one-liner describing what was found. */
  message: string;
  /** Actionable suggestion, shown for warnings/errors. */
  hint?: string;
}

/** The full result of {@link runDiagnostics}. */
export interface DiagnosticReport {
  checks: DiagnosticCheck[];
  /** True when no check is at `error` level (warnings still pass). */
  ok: boolean;
  /** Count of checks at each level, for a one-line summary. */
  counts: Record<DiagnosticLevel, number>;
}

/** Facts about the job store, gathered by the CLI before judging. */
export interface StoreFacts {
  /** Resolved store path (`~` already expanded). */
  path: string;
  /** Whether the file exists on disk. */
  exists: boolean;
  /**
   * True when the file existed but couldn't be parsed as a valid job array —
   * the store loader moves it aside, so this is a real "your data was bad" flag.
   */
  corrupt: boolean;
  /** Jobs currently in the store (0 when absent/corrupt). */
  jobCount: number;
  /** Jobs in a non-terminal state (queued/waiting_for_reset/resuming). */
  activeCount: number;
}

/** Facts about the config file, gathered by the CLI before judging. */
export interface ConfigFacts {
  /** Resolved config-file path, or null when none was found. */
  path: string | null;
  /** Set when a file was found but couldn't be read/parsed. */
  loadError: string | null;
  /** Semantic issues from `validateConfig` (empty when none / no file). */
  issues: ConfigIssue[];
}

/** Facts about configured notification channels. */
export interface NotifyFacts {
  /** Slack incoming-webhook URL, if set. */
  slackWebhook?: string;
  /** Generic webhook endpoint, if set. */
  webhookUrl?: string;
}

/** Everything {@link runDiagnostics} needs — collected by the CLI, judged here. */
export interface DiagnosticInput {
  /** Running Node version string, e.g. `process.version` ("v22.5.0"). */
  nodeVersion: string;
  store: StoreFacts;
  config: ConfigFacts;
  notify: NotifyFacts;
}

/** Minimum supported Node version — mirrors the packages' `engines.node`. */
export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 5;

/** The non-terminal statuses that make a job "active" (still being relayed). */
const ACTIVE_STATUSES = new Set<RelayJob["status"]>(["queued", "waiting_for_reset", "resuming"]);

/** Count jobs still in flight — handy for the CLI to build {@link StoreFacts}. */
export function countActiveJobs(jobs: RelayJob[]): number {
  return jobs.filter((job) => ACTIVE_STATUSES.has(job.status)).length;
}

/**
 * Parses a Node version string like `"v22.5.0"` or `"22.5"` into `{major, minor}`,
 * or null when it doesn't start with a numeric `major.minor`. Tolerant of a
 * leading `v` and trailing pre-release/build noise (`-nightly`, `+abc`).
 */
export function parseNodeVersion(version: string): { major: number; minor: number } | null {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/** True when `version` meets the {@link MIN_NODE_MAJOR}.{@link MIN_NODE_MINOR} floor. */
export function isSupportedNode(version: string): boolean {
  const parsed = parseNodeVersion(version);
  if (!parsed) return false;
  if (parsed.major !== MIN_NODE_MAJOR) return parsed.major > MIN_NODE_MAJOR;
  return parsed.minor >= MIN_NODE_MINOR;
}

/**
 * Judges already-gathered {@link DiagnosticInput} facts into a
 * {@link DiagnosticReport}. Pure — no filesystem, no env, no clock — so the CLI
 * `doctor` command and tests share exactly these rules.
 *
 * The checks, in order:
 * 1. **node** — the runtime meets the `>=22.5` engines floor.
 * 2. **store** — the job store is readable (corrupt → error; absent → an OK
 *    "will be created" note, since a fresh install has no store yet).
 * 3. **config** — the config file (if any) loads and validates; a broken file
 *    is an error, semantic warnings are surfaced as warnings.
 * 4. **notify** — at least one notification channel is set (absence is a
 *    warning, not an error: notifications are optional but you'd want to know
 *    the relay can't reach you).
 */
export function runDiagnostics(input: DiagnosticInput): DiagnosticReport {
  const checks: DiagnosticCheck[] = [];

  checks.push(nodeCheck(input.nodeVersion));
  checks.push(storeCheck(input.store));
  checks.push(configCheck(input.config));
  checks.push(notifyCheck(input.notify));

  const counts: Record<DiagnosticLevel, number> = { ok: 0, warning: 0, error: 0 };
  for (const check of checks) counts[check.level] += 1;

  return { checks, ok: counts.error === 0, counts };
}

function nodeCheck(version: string): DiagnosticCheck {
  const floor = `${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`;
  const parsed = parseNodeVersion(version);
  if (!parsed) {
    return {
      name: "node-version",
      level: "warning",
      message: `could not parse Node version "${version}"`,
      hint: `AgentRelay expects Node ${floor} or newer.`,
    };
  }
  if (!isSupportedNode(version)) {
    return {
      name: "node-version",
      level: "error",
      message: `Node ${parsed.major}.${parsed.minor} is below the required ${floor}`,
      hint: `Upgrade to Node ${floor}+ (nvm install ${MIN_NODE_MAJOR}).`,
    };
  }
  return {
    name: "node-version",
    level: "ok",
    message: `Node ${parsed.major}.${parsed.minor} meets the ${floor}+ requirement`,
  };
}

function storeCheck(store: StoreFacts): DiagnosticCheck {
  if (store.corrupt) {
    return {
      name: "store",
      level: "error",
      message: `job store at ${store.path} is corrupt and was moved aside`,
      hint: "Restore a snapshot with `agentrelay restore`, or start fresh (a new empty store was created).",
    };
  }
  if (!store.exists) {
    return {
      name: "store",
      level: "ok",
      message: `no job store yet at ${store.path} (it will be created on first run)`,
    };
  }
  const active = store.activeCount > 0 ? `, ${store.activeCount} active` : "";
  return {
    name: "store",
    level: "ok",
    message: `job store at ${store.path} is readable (${store.jobCount} job(s)${active})`,
  };
}

function configCheck(config: ConfigFacts): DiagnosticCheck {
  if (config.loadError) {
    return {
      name: "config",
      level: "error",
      message: `config file could not be loaded — ${config.loadError}`,
      hint: "Fix the JSON, or run `agentrelay config validate` for details.",
    };
  }
  if (!config.path) {
    return {
      name: "config",
      level: "ok",
      message: "no config file (using environment variables and built-in defaults)",
    };
  }
  const errors = config.issues.filter((issue) => issue.level === "error");
  if (errors.length > 0) {
    const first = errors[0];
    return {
      name: "config",
      level: "error",
      message: `config file ${config.path} has ${errors.length} error(s), e.g. ${first.path} ${first.message}`,
      hint: "Run `agentrelay config validate` to see every problem.",
    };
  }
  const warnings = config.issues.filter((issue) => issue.level === "warning");
  if (warnings.length > 0) {
    const first = warnings[0];
    return {
      name: "config",
      level: "warning",
      message: `config file ${config.path} loads but has ${warnings.length} warning(s), e.g. ${first.path} ${first.message}`,
      hint: "Run `agentrelay config validate` for the full list.",
    };
  }
  return { name: "config", level: "ok", message: `config file ${config.path} is valid` };
}

function notifyCheck(notify: NotifyFacts): DiagnosticCheck {
  const channels: string[] = [];
  if (notify.slackWebhook?.trim()) channels.push("Slack");
  if (notify.webhookUrl?.trim()) channels.push("webhook");
  if (channels.length === 0) {
    return {
      name: "notify",
      level: "warning",
      message: "no notification channel configured — you won't be alerted when a job resumes or fails",
      hint: "Set AGENTRELAY_SLACK_WEBHOOK or AGENTRELAY_WEBHOOK_URL (optional).",
    };
  }
  return { name: "notify", level: "ok", message: `notifications on via ${channels.join(" + ")}` };
}
