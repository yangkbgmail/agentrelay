import { describe, expect, it } from "vitest";
import {
  CONFIG_FIELDS,
  CONFIG_SCHEMA_DRAFT,
  CONFIG_SCHEMA_ID,
  configJsonSchema,
  configJsonSchemaJson,
  DURATION_SCHEMA_PATTERN,
  parseConfig,
  parseDuration,
  sampleConfig,
} from "./index.js";
import type { JsonSchema } from "./schema.js";

/** Walks a dotted key ("retry.factor") to its leaf property schema, or undefined. */
function propAt(schema: JsonSchema, dottedKey: string): JsonSchema | undefined {
  const parts = dottedKey.split(".");
  let node: JsonSchema | undefined = schema;
  for (const part of parts) {
    node = node?.properties?.[part];
    if (!node) return undefined;
  }
  return node;
}

describe("configJsonSchema", () => {
  const schema = configJsonSchema();

  it("declares draft-07 and a stable identity", () => {
    expect(schema.$schema).toBe(CONFIG_SCHEMA_DRAFT);
    expect(schema.$id).toBe(CONFIG_SCHEMA_ID);
    expect(schema.type).toBe("object");
  });

  it("stays permissive about unknown keys, matching parseConfig's forward-compat", () => {
    expect(schema.additionalProperties).toBe(true);
    for (const group of ["notify", "retry", "autoPrune"]) {
      expect(schema.properties?.[group]?.additionalProperties).toBe(true);
    }
  });

  it("describes the self-referential $schema key so a user's config validates", () => {
    expect(schema.properties?.$schema?.type).toBe("string");
  });

  it("covers every CONFIG_FIELDS key exactly — no missing, no extras", () => {
    // Collect every leaf property path the schema actually defines (excluding
    // the meta $schema key and the group container objects themselves).
    const schemaLeaves = new Set<string>();
    for (const [topKey, topVal] of Object.entries(schema.properties ?? {})) {
      if (topKey === "$schema") continue;
      if (topVal.type === "object" && topVal.properties) {
        for (const leaf of Object.keys(topVal.properties)) {
          schemaLeaves.add(`${topKey}.${leaf}`);
        }
      } else {
        schemaLeaves.add(topKey);
      }
    }
    const fieldKeys = new Set(CONFIG_FIELDS.map((f) => f.key));
    expect(schemaLeaves).toEqual(fieldKeys);
  });

  it("mirrors validateConfig numeric constraints", () => {
    expect(propAt(schema, "retry.maxAttempts")).toMatchObject({ type: "integer", minimum: 0 });
    expect(propAt(schema, "retry.baseDelayMs")).toMatchObject({ type: "integer", minimum: 0 });
    expect(propAt(schema, "retry.maxDelayMs")).toMatchObject({ type: "integer", minimum: 0 });
    expect(propAt(schema, "retry.factor")).toMatchObject({ type: "number", minimum: 1 });
    expect(propAt(schema, "retry.jitter")).toMatchObject({ type: "number", minimum: 0, maximum: 1 });
    expect(propAt(schema, "autoPrune.keep")).toMatchObject({ type: "integer", minimum: 0 });
    expect(propAt(schema, "autoPrune.everyTicks")).toMatchObject({ type: "integer", minimum: 0 });
  });

  it("types duration fields as strings with the shared pattern", () => {
    expect(propAt(schema, "autoPrune.after")).toMatchObject({ type: "string", pattern: DURATION_SCHEMA_PATTERN });
    expect(propAt(schema, "autoPrune.every")).toMatchObject({ type: "string", pattern: DURATION_SCHEMA_PATTERN });
  });

  it("marks webhook URL fields with a uri format hint", () => {
    expect(propAt(schema, "notify.slackWebhook")).toMatchObject({ type: "string", format: "uri" });
    expect(propAt(schema, "notify.webhookUrl")).toMatchObject({ type: "string", format: "uri" });
    // Non-URL secret has no format.
    expect(propAt(schema, "notify.webhookAuth")?.format).toBeUndefined();
  });

  it("gives every leaf property a human description", () => {
    for (const field of CONFIG_FIELDS) {
      const prop = propAt(schema, field.key);
      expect(prop?.description, `${field.key} should be documented`).toBeTruthy();
    }
  });

  it("places store at the top level and groups the rest", () => {
    expect(schema.properties?.store?.type).toBe("string");
    expect(schema.properties?.retry?.type).toBe("object");
    expect(schema.properties?.notify?.type).toBe("object");
    expect(schema.properties?.autoPrune?.type).toBe("object");
  });
});

describe("DURATION_SCHEMA_PATTERN", () => {
  const re = new RegExp(DURATION_SCHEMA_PATTERN);

  it("accepts exactly the durations parseDuration accepts, for a shared sample set", () => {
    const good = ["7d", "24h", "30m", "90s", "500ms", "1.5s", "24H", "500MS", "1 d", " 2h "];
    for (const d of good) {
      expect(re.test(d), `${d} should match the pattern`).toBe(true);
      expect(parseDuration(d), `${d} should parse`).not.toBeNull();
    }
  });

  it("rejects the same nonsense parseDuration rejects", () => {
    const bad = ["abc", "5x", "", "d", "1y", "ms"];
    for (const d of bad) {
      expect(re.test(d), `${d} should not match the pattern`).toBe(false);
      expect(parseDuration(d), `${d} should not parse`).toBeNull();
    }
  });

  it("matches the durations used in the sample config", () => {
    const sample = sampleConfig();
    expect(re.test(sample.autoPrune?.after ?? "")).toBe(true);
    expect(re.test(sample.autoPrune?.every ?? "")).toBe(true);
  });
});

describe("configJsonSchemaJson", () => {
  it("is pretty-printed with a trailing newline", () => {
    const json = configJsonSchemaJson();
    expect(json.endsWith("\n")).toBe(true);
    expect(json).toContain('\n  "properties"');
  });

  it("round-trips to the same object configJsonSchema returns", () => {
    expect(JSON.parse(configJsonSchemaJson())).toEqual(configJsonSchema());
  });

  it("validates the sample config's own field types against the derived schema", () => {
    // A light structural self-check: the sample config parses and every value it
    // sets corresponds to a described property in the schema.
    const sample = parseConfig(sampleConfig());
    const schema = configJsonSchema();
    if (sample.store !== undefined) expect(schema.properties?.store).toBeDefined();
    for (const key of Object.keys(sample.retry ?? {})) {
      expect(schema.properties?.retry?.properties?.[key], `retry.${key}`).toBeDefined();
    }
    for (const key of Object.keys(sample.autoPrune ?? {})) {
      expect(schema.properties?.autoPrune?.properties?.[key], `autoPrune.${key}`).toBeDefined();
    }
  });
});
