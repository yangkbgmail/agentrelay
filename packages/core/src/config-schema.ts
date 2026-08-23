import { CONFIG_FIELDS, type ConfigField, type ConfigGroup } from "./config.js";

/**
 * A machine-readable JSON Schema for `agentrelay.config.json`.
 *
 * Editors (VS Code, JetBrains, …) validate and auto-complete a JSON file when it
 * carries a `"$schema"` reference or the editor is told which schema to apply.
 * `agentrelay config schema` prints this document so users can point their
 * editor at it and get inline validation/completion for the config file —
 * catching typos (`retry.maxAttemps`) and out-of-range values *while typing*,
 * long before `config validate` or a daemon run would.
 *
 * The schema is **generated from {@link CONFIG_FIELDS}** — the same single source
 * of truth that drives `config set`/`get`/`show` — plus a small per-key
 * description/constraint table below. A test asserts every settable field shows
 * up in the schema, so a new config field can never silently drift out of it.
 */

/** JSON Schema draft the emitted document declares. */
export const CONFIG_SCHEMA_DIALECT = "http://json-schema.org/draft-07/schema#";

/** Stable `$id` for the schema (also the URL users reference via `"$schema"`). */
export const CONFIG_SCHEMA_ID = "https://github.com/yangkbgmail/agentrelay/config.schema.json";

/**
 * A best-effort regex for the duration strings {@link parseDuration} accepts
 * (`7d`, `24h`, `30m`, `90s`, `500ms`, decimals like `1.5h`), case-insensitive.
 * JSON Schema `pattern` has no case-insensitive flag, so the unit alternatives
 * spell out both cases. This is a hint for editors; the authoritative check is
 * still `parseDuration` at runtime / `config validate`.
 */
const DURATION_PATTERN = "^[0-9]+(\\.[0-9]+)?\\s*([mM][sS]|[sSmMhHdD])$";

/** A single JSON Schema property node. Kept loose — this module only writes it. */
type SchemaNode = Record<string, unknown>;

/** Per-field documentation and numeric constraints, keyed by dotted config key. */
interface FieldSchemaInfo {
  description: string;
  /** Inclusive lower bound for numeric fields. */
  minimum?: number;
  /** Inclusive upper bound for numeric fields. */
  maximum?: number;
  /** Whether a numeric field must be a whole number. */
  integer?: boolean;
}

/**
 * Documentation + constraints for each config key. The constraints intentionally
 * mirror {@link validateConfig}'s semantic rules so the editor hint and the CLI
 * check agree. Every key in {@link CONFIG_FIELDS} must appear here (a test
 * enforces it), so this is where new fields get documented.
 */
const FIELD_INFO: Record<string, FieldSchemaInfo> = {
  store: {
    description: "Path to the JSON job store (a leading ~ is expanded to the home directory).",
  },
  "notify.slackWebhook": {
    description: "Slack incoming-webhook URL; notifications are sent here when set.",
  },
  "notify.webhookUrl": {
    description: "Generic HTTP(S) endpoint that receives a JSON notification payload.",
  },
  "notify.webhookAuth": {
    description: "Value sent as the webhook Authorization header (e.g. 'Bearer <token>').",
  },
  "notify.desktop": {
    description: "Opt in to native OS desktop notifications (macOS/Linux/Windows) for queue events.",
  },
  "retry.maxAttempts": {
    description: "Maximum resume attempts before a job is marked failed (0 = unlimited).",
    minimum: 0,
    integer: true,
  },
  "retry.baseDelayMs": {
    description: "Base delay in milliseconds for the first backoff step.",
    minimum: 0,
    integer: true,
  },
  "retry.factor": {
    description: "Exponential backoff multiplier per attempt; must be at least 1.",
    minimum: 1,
  },
  "retry.maxDelayMs": {
    description: "Upper bound in milliseconds for a single backoff delay.",
    minimum: 0,
    integer: true,
  },
  "retry.jitter": {
    description: "Backoff jitter fraction in [0, 1] (0 disables jitter, 1 = ±100% spread).",
    minimum: 0,
    maximum: 1,
  },
  "autoPrune.enabled": {
    description: "Opt in to the daemon periodically pruning finished jobs from the store.",
  },
  "autoPrune.after": {
    description: 'Age threshold for pruning finished jobs, e.g. "7d", "24h", "30m" ("0s" = any age).',
  },
  "autoPrune.keep": {
    description: "Always keep the N most-recent finished jobs regardless of age.",
    minimum: 0,
    integer: true,
  },
  "autoPrune.every": {
    description: 'Minimum wall-clock interval between auto-prune passes, e.g. "1h", "30m".',
  },
  "autoPrune.everyTicks": {
    description: "Minimum number of daemon ticks between auto-prune passes.",
    minimum: 0,
    integer: true,
  },
};

/** Human-readable header for each config group in the generated schema. */
const GROUP_DESCRIPTION: Record<Exclude<ConfigGroup, "store">, string> = {
  notify: "Notification channels (Slack / generic webhook / native desktop).",
  retry: "Retry and exponential-backoff policy for resuming jobs.",
  autoPrune: "Daemon auto-prune settings for trimming the job store.",
};

/** Builds the JSON Schema node for one settable field from its type + info. */
function fieldNode(field: ConfigField, info: FieldSchemaInfo): SchemaNode {
  const node: SchemaNode = { description: info.description };
  switch (field.type) {
    case "string":
      node.type = "string";
      break;
    case "boolean":
      node.type = "boolean";
      break;
    case "duration":
      node.type = "string";
      node.pattern = DURATION_PATTERN;
      break;
    case "number":
      node.type = info.integer ? "integer" : "number";
      if (info.minimum !== undefined) node.minimum = info.minimum;
      if (info.maximum !== undefined) node.maximum = info.maximum;
      break;
  }
  return node;
}

/**
 * Builds the full JSON Schema object for `agentrelay.config.json`. Pure — no
 * filesystem, no env. Generated from {@link CONFIG_FIELDS}, so it always covers
 * exactly the settable fields.
 */
export function buildConfigJsonSchema(): SchemaNode {
  // Top-level properties: `store` (flat) plus one object per group.
  const rootProps: Record<string, SchemaNode> = {
    // Permit an inline `$schema` reference so editors that store it in the file
    // itself don't flag it under additionalProperties:false.
    $schema: {
      type: "string",
      description: "JSON Schema reference for editor validation/completion.",
    },
  };
  // Group object nodes, created lazily as fields are encountered.
  const groupProps: Partial<Record<Exclude<ConfigGroup, "store">, Record<string, SchemaNode>>> = {};

  for (const field of CONFIG_FIELDS) {
    const info = FIELD_INFO[field.key];
    if (!info) {
      // Should be unreachable — a test asserts FIELD_INFO covers every field —
      // but fail loudly rather than emit an undocumented property.
      throw new Error(`config-schema: missing FIELD_INFO for "${field.key}"`);
    }
    const node = fieldNode(field, info);
    if (field.group === "store") {
      rootProps[field.key] = node;
      continue;
    }
    const leaf = field.key.slice(field.group.length + 1); // strip "group."
    let bucket = groupProps[field.group];
    if (!bucket) {
      bucket = {};
      groupProps[field.group] = bucket;
    }
    bucket[leaf] = node;
  }

  for (const group of Object.keys(groupProps) as Array<Exclude<ConfigGroup, "store">>) {
    rootProps[group] = {
      type: "object",
      description: GROUP_DESCRIPTION[group],
      additionalProperties: false,
      properties: groupProps[group],
    };
  }

  return {
    $schema: CONFIG_SCHEMA_DIALECT,
    $id: CONFIG_SCHEMA_ID,
    title: "AgentRelay configuration",
    description:
      "Persistent defaults for AgentRelay (agentrelay.config.json). Every field is optional; an explicit AGENTRELAY_* environment variable overrides the file, which overrides the built-in default.",
    type: "object",
    additionalProperties: false,
    properties: rootProps,
  };
}

/**
 * The {@link buildConfigJsonSchema} document rendered as pretty-printed JSON
 * with a trailing newline — ready to print or write to a `.schema.json` file.
 */
export function configJsonSchemaJson(): string {
  return `${JSON.stringify(buildConfigJsonSchema(), null, 2)}\n`;
}
