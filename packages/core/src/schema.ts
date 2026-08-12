// JSON Schema generation for `agentrelay.config.json`. Editors (VS Code and
// anything speaking the JSON language server) validate and autocomplete a JSON
// file when it carries a `"$schema"` pointer, so shipping a schema turns the
// config file into a guided, typo-proof editing experience — the missing piece
// next to `config init` (writes a sample), `config validate` (checks a file),
// and `config set` (edits one key).
//
// The schema is DERIVED from {@link CONFIG_FIELDS}, the same single source of
// truth that `config set`/`config get`/`config validate` already key off, so it
// can never drift from the fields the CLI actually understands: add a field
// there and it appears here automatically. Everything is pure (no filesystem,
// no clock) so the CLI layer decides where the bytes go.

import { CONFIG_FIELDS, type ConfigField, type ConfigFieldType } from "./config.js";

/**
 * `$id` advertised by the generated schema. A stable, resolvable-looking URI so
 * a user can pin `"$schema": "<this>"` in their config; it doubles as the
 * schema's identity if a tool caches it.
 */
export const CONFIG_JSON_SCHEMA_ID = "https://agentrelay.dev/schema/agentrelay.config.schema.json";

/** Draft the emitted schema targets — draft-07 is the widest-supported dialect. */
export const CONFIG_JSON_SCHEMA_DIALECT = "http://json-schema.org/draft-07/schema#";

/**
 * Regex a `duration` field must match, mirroring the core `parseDuration`
 * grammar (`7d`, `24h`, `30m`, `90s`, `500ms`, optional decimals/space). JSON
 * Schema `pattern` is case-sensitive ECMA regex, so the unit alternation lists
 * both cases to match `parseDuration`'s case-insensitive behaviour.
 */
export const DURATION_PATTERN = "^\\d+(\\.\\d+)?\\s*([Mm][Ss]|[SsMmHhDd])$";

/** Per-key human descriptions surfaced in editor tooltips (presentation only). */
const FIELD_DESCRIPTIONS: Record<string, string> = {
  store: "Job store path (maps to AGENTRELAY_STORE). Supports a leading ~ for the home directory.",
  "notify.slackWebhook": "Slack incoming-webhook URL (AGENTRELAY_SLACK_WEBHOOK). Empty disables Slack.",
  "notify.webhookUrl": "Generic webhook endpoint that receives JSON events (AGENTRELAY_WEBHOOK_URL).",
  "notify.webhookAuth": "Value sent as the webhook Authorization header (AGENTRELAY_WEBHOOK_AUTH).",
  "retry.maxAttempts":
    "Max resume attempts before a job is marked failed; 0 means unlimited (AGENTRELAY_MAX_ATTEMPTS).",
  "retry.baseDelayMs": "Base backoff delay in ms before the first transient-failure retry (AGENTRELAY_RETRY_BASE_MS).",
  "retry.factor": "Multiplier applied to the backoff delay on each subsequent attempt (AGENTRELAY_RETRY_FACTOR).",
  "retry.maxDelayMs": "Upper bound in ms on any single backoff delay (AGENTRELAY_RETRY_MAX_MS).",
  "retry.jitter": "Backoff jitter fraction in [0, 1]; 0 keeps backoff deterministic (AGENTRELAY_RETRY_JITTER).",
  "autoPrune.enabled": "Opt in to daemon auto-prune of finished jobs (AGENTRELAY_AUTOPRUNE).",
  "autoPrune.after": "Age threshold like 7d/24h before a finished job is prunable (AGENTRELAY_AUTOPRUNE_AFTER).",
  "autoPrune.keep": "Always keep the N most-recent finished jobs (AGENTRELAY_AUTOPRUNE_KEEP).",
  "autoPrune.every": "Minimum wall-clock interval between auto-prune passes, e.g. 1h (AGENTRELAY_AUTOPRUNE_EVERY).",
  "autoPrune.everyTicks": "Minimum daemon ticks between auto-prune passes (AGENTRELAY_AUTOPRUNE_EVERY_TICKS).",
};

/** Descriptions for the top-level group objects that hold nested fields. */
const GROUP_DESCRIPTIONS: Record<string, string> = {
  notify: "Notification channels. Empty/omitted values disable a channel.",
  retry: "Retry and exponential-backoff policy for resumed jobs.",
  autoPrune: "Daemon auto-prune settings for keeping jobs.json from growing without bound.",
};

/** A single JSON Schema node — kept loose since it's a plain serializable tree. */
type SchemaNode = Record<string, unknown>;

/** Maps a config field's value type onto its JSON Schema node. */
function nodeForField(field: ConfigField): SchemaNode {
  const node = leafNodeForType(field.type);
  const description = FIELD_DESCRIPTIONS[field.key];
  if (description) node.description = description;
  return node;
}

/** The bare type node for a {@link ConfigFieldType}, before descriptions. */
function leafNodeForType(type: ConfigFieldType): SchemaNode {
  switch (type) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "duration":
      // Stored as a string but constrained to the duration grammar so a typo is
      // flagged in-editor rather than silently ignored at runtime.
      return { type: "string", pattern: DURATION_PATTERN };
  }
}

/**
 * Builds a draft-07 JSON Schema for `agentrelay.config.json`, derived entirely
 * from {@link CONFIG_FIELDS}. Nested dotted keys (`retry.maxAttempts`) become
 * nested object properties; single-segment keys (`store`) sit at the root.
 *
 * `additionalProperties` is left permissive at every level to mirror
 * `parseConfig`, which ignores unknown keys for forward-compatibility — so a
 * config written for a newer agentrelay still validates against an older schema
 * (and a stray `"$schema"` pointer is always allowed). Pure and deterministic.
 */
export function buildConfigJsonSchema(): SchemaNode {
  const properties: Record<string, SchemaNode> = {};

  for (const field of CONFIG_FIELDS) {
    const segments = field.key.split(".");
    if (segments.length === 1) {
      properties[segments[0]] = nodeForField(field);
      continue;
    }
    const [group, child] = segments;
    let groupNode = properties[group];
    if (!groupNode) {
      groupNode = { type: "object", properties: {} };
      const groupDescription = GROUP_DESCRIPTIONS[group];
      if (groupDescription) groupNode.description = groupDescription;
      properties[group] = groupNode;
    }
    (groupNode.properties as Record<string, SchemaNode>)[child] = nodeForField(field);
  }

  return {
    $schema: CONFIG_JSON_SCHEMA_DIALECT,
    $id: CONFIG_JSON_SCHEMA_ID,
    title: "AgentRelay config",
    description:
      "Persistent defaults for the agentrelay CLI (agentrelay.config.json). " +
      "Unknown keys are ignored for forward-compatibility. Precedence at runtime: env / CLI > config file > built-in defaults.",
    type: "object",
    properties,
  };
}

/**
 * {@link buildConfigJsonSchema} rendered as a pretty-printed JSON string with a
 * trailing newline — ready to write to a `.json` file or pipe to stdout. Mirrors
 * {@link sampleConfigJson} so both emitters format identically.
 */
export function configJsonSchemaJson(): string {
  return `${JSON.stringify(buildConfigJsonSchema(), null, 2)}\n`;
}
