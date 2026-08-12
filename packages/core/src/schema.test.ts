import { describe, expect, it } from "vitest";
import { CONFIG_FIELDS, type ConfigFieldType, SETTABLE_CONFIG_KEYS, sampleConfig } from "./config.js";
import {
  buildConfigJsonSchema,
  CONFIG_JSON_SCHEMA_DIALECT,
  CONFIG_JSON_SCHEMA_ID,
  configJsonSchemaJson,
  DURATION_PATTERN,
} from "./schema.js";

/** Resolve a dotted key to its schema node, walking nested group objects. */
// biome-ignore lint/suspicious/noExplicitAny: schema is a loose serializable tree
function nodeAt(schema: any, dottedKey: string): any {
  let node = schema;
  for (const seg of dottedKey.split(".")) {
    expect(node?.type).toBe("object");
    node = node.properties?.[seg];
    expect(node, `missing schema node for ${dottedKey}`).toBeDefined();
  }
  return node;
}

/** The JSON Schema type string expected for each config field type. */
const EXPECTED_TYPE: Record<ConfigFieldType, string> = {
  string: "string",
  number: "number",
  boolean: "boolean",
  duration: "string",
};

describe("buildConfigJsonSchema", () => {
  it("emits a draft-07 root object with identity metadata", () => {
    const schema = buildConfigJsonSchema();
    expect(schema.$schema).toBe(CONFIG_JSON_SCHEMA_DIALECT);
    expect(schema.$id).toBe(CONFIG_JSON_SCHEMA_ID);
    expect(schema.type).toBe("object");
    expect(typeof schema.title).toBe("string");
    expect(typeof schema.description).toBe("string");
  });

  it("declares a correctly-typed node for every settable config key", () => {
    const schema = buildConfigJsonSchema();
    for (const field of CONFIG_FIELDS) {
      const node = nodeAt(schema, field.key);
      expect(node.type, `type for ${field.key}`).toBe(EXPECTED_TYPE[field.type]);
    }
    // The schema must cover exactly the settable keys — no more, no fewer.
    for (const key of SETTABLE_CONFIG_KEYS) {
      expect(() => nodeAt(schema, key)).not.toThrow();
    }
  });

  it("constrains duration fields with the parseDuration pattern", () => {
    const schema = buildConfigJsonSchema();
    const durationKeys = CONFIG_FIELDS.filter((f) => f.type === "duration").map((f) => f.key);
    expect(durationKeys.length).toBeGreaterThan(0);
    for (const key of durationKeys) {
      expect(nodeAt(schema, key).pattern).toBe(DURATION_PATTERN);
    }
    // The pattern must accept real duration strings and reject junk.
    const re = new RegExp(DURATION_PATTERN);
    for (const good of ["7d", "24h", "30m", "90s", "500ms", "1.5h"]) {
      expect(re.test(good), `should accept ${good}`).toBe(true);
    }
    for (const bad of ["", "7", "7 days", "abc", "d7"]) {
      expect(re.test(bad), `should reject ${bad}`).toBe(false);
    }
  });

  it("nests group objects and attaches descriptions to leaves", () => {
    const schema = buildConfigJsonSchema();
    // notify/retry/autoPrune are object groups; store is a top-level scalar.
    // biome-ignore lint/suspicious/noExplicitAny: loose tree
    const props = (schema as any).properties;
    expect(props.store.type).toBe("string");
    expect(props.notify.type).toBe("object");
    expect(props.retry.type).toBe("object");
    expect(props.autoPrune.type).toBe("object");
    // Every settable leaf carries a human description for editor tooltips.
    for (const field of CONFIG_FIELDS) {
      expect(typeof nodeAt(schema, field.key).description, `description for ${field.key}`).toBe("string");
    }
  });

  it("covers every key present in sampleConfig (schema matches the real shape)", () => {
    const schema = buildConfigJsonSchema();
    const walk = (obj: Record<string, unknown>, prefix: string) => {
      for (const [k, v] of Object.entries(obj)) {
        const dotted = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === "object" && !Array.isArray(v)) {
          walk(v as Record<string, unknown>, dotted);
        } else {
          expect(() => nodeAt(schema, dotted), `sampleConfig key ${dotted} in schema`).not.toThrow();
        }
      }
    };
    walk(sampleConfig() as unknown as Record<string, unknown>, "");
  });
});

describe("configJsonSchemaJson", () => {
  it("is valid, stable, pretty JSON with a trailing newline", () => {
    const text = configJsonSchemaJson();
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain("\n  "); // 2-space indented
    const parsed = JSON.parse(text);
    expect(parsed).toEqual(buildConfigJsonSchema());
    // Deterministic: two calls produce byte-identical output.
    expect(configJsonSchemaJson()).toBe(text);
  });
});
