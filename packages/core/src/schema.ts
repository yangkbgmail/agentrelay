// A JSON Schema (draft-07) generator for `agentrelay.config.json`.
//
// The config file is hand-editable JSON with no comments, so the two ways a
// user learns its shape today are `config init` (a fully-populated sample) and
// `config validate` (after-the-fact checking). Neither helps *while typing* in
// an editor. A JSON Schema closes that gap: drop a
// `"$schema": "./agentrelay.config.schema.json"` line into the config and any
// modern editor gives autocomplete, inline docs, and red squiggles on a bad
// value — before the CLI ever runs.
//
// The schema is *derived* from {@link CONFIG_FIELDS}, the same single source of
// truth `config set`/`config show` use, so it can never drift out of sync with
// the fields the tool actually reads (a test asserts every field is covered and
// no extras sneak in). The per-field constraints (minimums, the duration
// pattern, the `[0,1]` jitter range) mirror {@link validateConfig} exactly, so
// an editor flags the same mistakes `config validate` would.

import type { ConfigField, ConfigGroup } from "./config.js";
import { CONFIG_FIELDS } from "./config.js";

/** A minimal structural type for the draft-07 fragments this module emits. */
export interface JsonSchema {
  $schema?: string;
  $id?: string;
  title?: string;
  description?: string;
  type?: string;
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean;
  properties?: Record<string, JsonSchema>;
}

/** The draft this schema targets — the most broadly supported by editors. */
export const CONFIG_SCHEMA_DRAFT = "http://json-schema.org/draft-07/schema#";

/**
 * A stable identity for the generated schema. A `$id` is an *identifier*, not a
 * fetch target — editors reference the schema via the config file's relative
 * `"$schema": "./agentrelay.config.schema.json"`, so nothing needs to be hosted
 * at this URL for validation to work.
 */
export const CONFIG_SCHEMA_ID =
  "https://raw.githubusercontent.com/yangkbgmail/agentrelay/main/agentrelay.config.schema.json";

/**
 * A JSON Schema `pattern` (regex source) accepting the same duration strings as
 * the core {@link parseDuration}: an integer or decimal followed by a `ms`, `s`,
 * `m`, `h`, or `d` unit, case-insensitive, with optional surrounding/internal
 * whitespace (the runtime trims first). Two-letter `ms` is matched before the
 * single-letter units so the whole token is consumed. A test cross-checks this
 * against `parseDuration` so the two stay in agreement.
 */
export const DURATION_SCHEMA_PATTERN = "^\\s*\\d+(?:\\.\\d+)?\\s*(?:[mM][sS]|[smhdSMHD])\\s*$";

/** One-line human docs for each config group's object, used as `description`. */
const GROUP_DESCRIPTIONS: Record<Exclude<ConfigGroup, "store">, string> = {
  notify: "Notification channels. Rate-limit and resume events fan out to every configured channel.",
  retry: "Retry / exponential-backoff policy for transient (non rate-limit) failures.",
  autoPrune: "Daemon auto-prune settings — how finished jobs are trimmed from the store over time.",
};

/**
 * Extra per-field schema constraints layered on top of the base type implied by
 * {@link ConfigField.type}. Keyed by the field's dotted key. `integer` narrows a
 * `number` field to `"integer"`; the numeric bounds and formats mirror
 * {@link validateConfig}. Every entry in {@link CONFIG_FIELDS} must appear here
 * (a test enforces it), so a newly added field can't silently ship an untyped,
 * undocumented schema property.
 */
interface FieldSchemaExtra {
  description: string;
  /** Narrow a `number` field to a whole number (`"integer"`). */
  integer?: boolean;
  minimum?: number;
  maximum?: number;
  /** A non-standard `format` hint (e.g. `"uri"`) for editor tooling. */
  format?: string;
}

const FIELD_EXTRAS: Record<string, FieldSchemaExtra> = {
  store: {
    description: "Path to the job store JSON file. A leading ~ is expanded to your home directory.",
  },
  "notify.slackWebhook": {
    description: "Slack incoming-webhook URL. Rate-limit/resume events are posted here when set.",
    format: "uri",
  },
  "notify.webhookUrl": {
    description: "Generic HTTP(S) endpoint that receives a JSON event payload for each notification.",
    format: "uri",
  },
  "notify.webhookAuth": {
    description: "Value sent verbatim as the webhook's Authorization header (e.g. a bearer token).",
  },
  "retry.maxAttempts": {
    description: "Maximum resume attempts before a job is marked failed. 0 means unlimited.",
    integer: true,
    minimum: 0,
  },
  "retry.baseDelayMs": {
    description: "First backoff delay in milliseconds; each retry multiplies it by `factor`.",
    integer: true,
    minimum: 0,
  },
  "retry.factor": {
    description: "Exponential-backoff multiplier. Must be at least 1, or the delay would shrink.",
    minimum: 1,
  },
  "retry.maxDelayMs": {
    description: "Upper bound (milliseconds) the backoff delay is clamped to.",
    integer: true,
    minimum: 0,
  },
  "retry.jitter": {
    description: "Randomization fraction in [0,1] spread over the delay to avoid lockstep retries.",
    minimum: 0,
    maximum: 1,
  },
  "autoPrune.enabled": {
    description: "Opt-in switch: when true, the daemon prunes finished jobs on its own schedule.",
  },
  "autoPrune.after": {
    description: 'Age threshold like "7d", "24h", or "30m". Finished jobs older than this are pruned.',
  },
  "autoPrune.keep": {
    description: "Always keep the N most-recent finished jobs, regardless of age.",
    integer: true,
    minimum: 0,
  },
  "autoPrune.every": {
    description: 'Minimum wall-clock interval between prune passes, like "1h" or "30m".',
  },
  "autoPrune.everyTicks": {
    description: "Minimum number of daemon ticks between prune passes.",
    integer: true,
    minimum: 0,
  },
};

/** Builds the leaf property schema for one settable config field. Pure. */
function fieldSchema(field: ConfigField): JsonSchema {
  const extra = FIELD_EXTRAS[field.key];
  if (!extra) {
    // Guarded by a coverage test, but fail loudly rather than emit a bare field.
    throw new Error(`No schema metadata for config field "${field.key}"`);
  }

  const prop: JsonSchema = { description: extra.description };
  switch (field.type) {
    case "string":
      prop.type = "string";
      if (extra.format) prop.format = extra.format;
      break;
    case "number":
      prop.type = extra.integer ? "integer" : "number";
      if (extra.minimum !== undefined) prop.minimum = extra.minimum;
      if (extra.maximum !== undefined) prop.maximum = extra.maximum;
      break;
    case "boolean":
      prop.type = "boolean";
      break;
    case "duration":
      prop.type = "string";
      prop.pattern = DURATION_SCHEMA_PATTERN;
      break;
  }
  return prop;
}

/**
 * Builds the full JSON Schema (draft-07) for `agentrelay.config.json`, derived
 * from {@link CONFIG_FIELDS}. Pure — no filesystem, no env.
 *
 * `additionalProperties` is left permissive (`true`) at every level to mirror
 * the runtime: `parseConfig` ignores unknown keys for forward-compatibility, so
 * a strict schema would flag a future field as an error before the tool itself
 * would. The top-level `$schema` property is described explicitly so the
 * self-reference users add to their config validates cleanly.
 */
export function configJsonSchema(): JsonSchema {
  const properties: Record<string, JsonSchema> = {
    $schema: {
      type: "string",
      description: "Optional path or URL to this JSON Schema, enabling editor validation and autocomplete.",
    },
  };

  for (const field of CONFIG_FIELDS) {
    const prop = fieldSchema(field);
    const parts = field.key.split(".");
    if (parts.length === 1) {
      properties[parts[0]] = prop;
      continue;
    }
    const [group, leaf] = parts;
    let groupObj = properties[group];
    if (!groupObj) {
      groupObj = {
        type: "object",
        description: GROUP_DESCRIPTIONS[group as Exclude<ConfigGroup, "store">],
        additionalProperties: true,
        properties: {},
      };
      properties[group] = groupObj;
    }
    // biome-ignore lint/style/noNonNullAssertion: group objects are created with `properties`.
    groupObj.properties![leaf] = prop;
  }

  return {
    $schema: CONFIG_SCHEMA_DRAFT,
    $id: CONFIG_SCHEMA_ID,
    title: "AgentRelay configuration",
    description:
      "Schema for agentrelay.config.json — the defaults file AgentRelay reads. " +
      "Every field is optional; omitting one uses the built-in default.",
    type: "object",
    additionalProperties: true,
    properties,
  };
}

/**
 * The {@link configJsonSchema} rendered as pretty-printed JSON with a trailing
 * newline — ready to write to a `.schema.json` file. Exported so the CLI and any
 * tooling emit byte-identical output.
 */
export function configJsonSchemaJson(): string {
  return `${JSON.stringify(configJsonSchema(), null, 2)}\n`;
}
