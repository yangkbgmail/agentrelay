/**
 * A single-source reference for every environment variable AgentRelay reads.
 *
 * Env vars are the tool's primary knobs, but they were scattered across the
 * codebase (config, scheduler concurrency, config-file discovery) with no one
 * place that answers "what can I actually set, and what is set right now?".
 * `config show` only covers the *config-backed* subset (the ones an
 * `agentrelay.config.json` can also populate), and it reports them in config
 * terms — it never mentions `AGENTRELAY_CONFIG` (which selects the config file
 * itself) or `AGENTRELAY_MAX_CONCURRENT` (the scheduler knob), and it carries
 * no human description of what each var does.
 *
 * This module is that missing reference: a static registry ({@link ENV_VARS})
 * plus a pure resolver ({@link describeEnv}) that snapshots each var's current
 * state against a given environment. The CLI `env` command renders it; keeping
 * the data here means the dashboard (or any other entry point) can reuse the
 * exact same catalogue.
 */

import { CONFIG_ENV_KEYS } from "./config.js";

/** Which concern an env var belongs to, used only for grouped display. */
export type EnvVarCategory = "store" | "config" | "notify" | "retry" | "autoPrune" | "scheduler";

/** Static documentation for one `AGENTRELAY_*` (or related) environment variable. */
export interface EnvVarDoc {
  /** The variable name, e.g. `AGENTRELAY_STORE`. */
  key: string;
  /** Concern this var belongs to (for grouped display). */
  category: EnvVarCategory;
  /** One-line, human-readable description of what setting it does. */
  description: string;
  /**
   * Whether an `agentrelay.config.json` can also supply this value (via
   * `config set`). Purely-env vars (the config file path selector, the
   * scheduler concurrency knob) are `false`.
   */
  configBacked: boolean;
  /** Values that must never be printed in full (webhook URLs / auth tokens). */
  secret?: boolean;
  /**
   * Human-readable built-in default applied when the var is unset (and no
   * config file supplies it). Omitted when there is no meaningful default.
   */
  defaultHint?: string;
}

/**
 * Every environment variable AgentRelay reads, in display order (grouped by
 * concern). The config-backed entries mirror {@link CONFIG_ENV_KEYS} exactly —
 * a test asserts every config-backed env key appears here — so this catalogue
 * can never silently fall behind the config schema. The two purely-env
 * entries (`AGENTRELAY_CONFIG`, `AGENTRELAY_MAX_CONCURRENT`) live only here,
 * which is the whole point: they have no `config show` home.
 */
export const ENV_VARS: EnvVarDoc[] = [
  {
    key: "AGENTRELAY_STORE",
    category: "store",
    description: "Path to the JSON job store the queue reads and writes.",
    configBacked: true,
    defaultHint: "~/.agentrelay/jobs.json",
  },
  {
    key: "AGENTRELAY_CONFIG",
    category: "config",
    description: "Explicit path to agentrelay.config.json, overriding directory discovery.",
    configBacked: false,
    defaultHint: "discover ./agentrelay.config.json then ~/.agentrelay/config.json",
  },
  {
    key: "AGENTRELAY_SLACK_WEBHOOK",
    category: "notify",
    description: "Slack incoming-webhook URL; notifications are sent here when set.",
    configBacked: true,
    secret: true,
    defaultHint: "no Slack notifications",
  },
  {
    key: "AGENTRELAY_WEBHOOK_URL",
    category: "notify",
    description: "Generic webhook endpoint that receives a JSON payload on job events.",
    configBacked: true,
    secret: true,
    defaultHint: "no webhook notifications",
  },
  {
    key: "AGENTRELAY_WEBHOOK_AUTH",
    category: "notify",
    description: "Value sent as the Authorization header on the generic webhook request.",
    configBacked: true,
    secret: true,
    defaultHint: "no Authorization header",
  },
  {
    key: "AGENTRELAY_MAX_ATTEMPTS",
    category: "retry",
    description: "Maximum resume attempts per job before it is marked failed (0 = unlimited).",
    configBacked: true,
    defaultHint: "5",
  },
  {
    key: "AGENTRELAY_RETRY_BASE_MS",
    category: "retry",
    description: "Base delay in milliseconds for the exponential-backoff retry schedule.",
    configBacked: true,
    defaultHint: "1000",
  },
  {
    key: "AGENTRELAY_RETRY_FACTOR",
    category: "retry",
    description: "Multiplier applied to the delay after each failed attempt.",
    configBacked: true,
    defaultHint: "2",
  },
  {
    key: "AGENTRELAY_RETRY_MAX_MS",
    category: "retry",
    description: "Ceiling in milliseconds for a single backoff delay.",
    configBacked: true,
    defaultHint: "300000",
  },
  {
    key: "AGENTRELAY_RETRY_JITTER",
    category: "retry",
    description: "Backoff jitter fraction in [0, 1] that randomizes each delay.",
    configBacked: true,
    defaultHint: "0",
  },
  {
    key: "AGENTRELAY_MAX_CONCURRENT",
    category: "scheduler",
    description: "How many due jobs the scheduler may resume in parallel per pass.",
    configBacked: false,
    defaultHint: "1 (serial)",
  },
  {
    key: "AGENTRELAY_AUTOPRUNE",
    category: "autoPrune",
    description: "Opt-in flag; when truthy the daemon prunes old finished jobs periodically.",
    configBacked: true,
    defaultHint: "off",
  },
  {
    key: "AGENTRELAY_AUTOPRUNE_AFTER",
    category: "autoPrune",
    description: "Age threshold (e.g. 7d, 24h) past which finished jobs are eligible for pruning.",
    configBacked: true,
    defaultHint: "7d",
  },
  {
    key: "AGENTRELAY_AUTOPRUNE_KEEP",
    category: "autoPrune",
    description: "Always keep at least the N most-recent finished jobs when pruning.",
    configBacked: true,
    defaultHint: "50",
  },
  {
    key: "AGENTRELAY_AUTOPRUNE_EVERY",
    category: "autoPrune",
    description: "Minimum wall-clock interval between auto-prune passes.",
    configBacked: true,
    defaultHint: "1h",
  },
  {
    key: "AGENTRELAY_AUTOPRUNE_EVERY_TICKS",
    category: "autoPrune",
    description: "Minimum number of scheduler ticks between auto-prune passes.",
    configBacked: true,
    defaultHint: "20",
  },
];

/** The resolved state of one env var against a concrete environment. */
export interface EnvVarState extends EnvVarDoc {
  /** Whether the variable is set to a non-empty value in the inspected env. */
  set: boolean;
  /**
   * The raw value as read from the environment, or `undefined` when unset. Not
   * redacted — callers that display it are responsible for masking secrets.
   */
  value: string | undefined;
}

/**
 * Snapshots every {@link ENV_VARS} entry against `env`, reporting whether each
 * is currently set and its raw value. A variable present but blank/whitespace
 * counts as *not set* (matching how the rest of the code treats blank env
 * vars — see `maxConcurrentFromEnv`/`resolveConfigPath`), so an accidental
 * empty export is reported honestly rather than as an active override.
 *
 * Pure — no ambient env unless `env` is omitted — so the CLI and tests share
 * exactly this resolution.
 */
export function describeEnv(env: Record<string, string | undefined> = process.env): EnvVarState[] {
  return ENV_VARS.map((doc): EnvVarState => {
    const raw = env[doc.key];
    const set = raw !== undefined && raw.trim() !== "";
    return { ...doc, set, value: set ? raw : undefined };
  });
}

/**
 * Guard used by the sync test: the set of config-backed env keys declared here
 * must equal the keys {@link CONFIG_ENV_KEYS} enumerates, so the two registries
 * can't drift. Returned as a diff for a readable assertion message.
 */
export function configBackedEnvDrift(): { missingHere: string[]; extraHere: string[] } {
  const here = new Set(ENV_VARS.filter((v) => v.configBacked).map((v) => v.key));
  const there = new Set(CONFIG_ENV_KEYS.map((k) => k.key));
  const missingHere = [...there].filter((k) => !here.has(k));
  const extraHere = [...here].filter((k) => !there.has(k));
  return { missingHere, extraHere };
}
