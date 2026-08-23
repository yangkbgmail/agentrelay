import { describe, expect, it } from "vitest";
import { CONFIG_FIELDS, parseConfig, sampleConfig } from "./config.js";
import {
  buildConfigJsonSchema,
  CONFIG_SCHEMA_DIALECT,
  CONFIG_SCHEMA_ID,
  configJsonSchemaJson,
} from "./config-schema.js";
import { parseDuration } from "./prune.js";

type SchemaNode = Record<string, unknown>;

function props(schema: SchemaNode): Record<string, SchemaNode> {
  return schema.properties as Record<string, SchemaNode>;
}

/** Resolves a dotted config key to its JSON Schema node, or undefined. */
function nodeForKey(schema: SchemaNode, dottedKey: string): SchemaNode | undefined {
  const parts = dottedKey.split(".");
  if (parts.length === 1) return props(schema)[parts[0]];
  const group = props(schema)[parts[0]];
  if (!group) return undefined;
  return props(group)[parts[1]];
}

describe("buildConfigJsonSchema", () => {
  const schema = buildConfigJsonSchema();

  it("declares the draft-07 dialect and a stable $id", () => {
    expect(schema.$schema).toBe(CONFIG_SCHEMA_DIALECT);
    expect(schema.$id).toBe(CONFIG_SCHEMA_ID);
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
  });

  it("has a node for every settable config field", () => {
    for (const field of CONFIG_FIELDS) {
      const node = nodeForKey(schema, field.key);
      expect(node, `missing schema node for ${field.key}`).toBeDefined();
      expect(typeof (node as SchemaNode).description).toBe("string");
      expect(((node as SchemaNode).description as string).length).toBeGreaterThan(0);
    }
  });

  it("allows an inline $schema reference at the top level", () => {
    expect(props(schema).$schema).toMatchObject({ type: "string" });
  });

  it("maps field types to the right JSON Schema types", () => {
    expect(nodeForKey(schema, "store")).toMatchObject({ type: "string" });
    expect(nodeForKey(schema, "autoPrune.enabled")).toMatchObject({ type: "boolean" });
    // integer numeric field
    expect(nodeForKey(schema, "retry.maxAttempts")).toMatchObject({ type: "integer", minimum: 0 });
    // non-integer numeric field with a bounded range
    expect(nodeForKey(schema, "retry.jitter")).toMatchObject({ type: "number", minimum: 0, maximum: 1 });
    // factor must be >= 1 (mirrors validateConfig)
    expect(nodeForKey(schema, "retry.factor")).toMatchObject({ type: "number", minimum: 1 });
  });

  it("gives duration fields a string type with a pattern", () => {
    const after = nodeForKey(schema, "autoPrune.after") as SchemaNode;
    expect(after.type).toBe("string");
    expect(typeof after.pattern).toBe("string");
    const re = new RegExp(after.pattern as string);
    // Valid durations the runtime parser accepts should match the hint pattern.
    for (const good of ["7d", "24h", "30m", "90s", "500ms", "1.5h", "0s"]) {
      expect(parseDuration(good), `${good} should parse`).not.toBeNull();
      expect(re.test(good), `${good} should match pattern`).toBe(true);
    }
    // Obvious garbage should be rejected by the pattern too.
    for (const bad of ["soon", "10x", ""]) {
      expect(re.test(bad), `${bad} should not match`).toBe(false);
    }
  });

  it("marks group objects as closed (additionalProperties:false)", () => {
    for (const group of ["notify", "retry", "autoPrune"]) {
      expect(props(schema)[group]).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("validates the shipped sampleConfig against its own constraints", () => {
    // A light structural check: every value in sampleConfig fits the schema
    // node's declared type and numeric bounds. Guards against the sample and the
    // schema drifting apart.
    const sample = sampleConfig();
    const check = (dottedKey: string, value: unknown) => {
      const node = nodeForKey(schema, dottedKey) as SchemaNode;
      expect(node, dottedKey).toBeDefined();
      if (node.type === "integer") {
        expect(Number.isInteger(value)).toBe(true);
      }
      if (node.type === "number" || node.type === "integer") {
        if (node.minimum !== undefined) expect(value as number).toBeGreaterThanOrEqual(node.minimum as number);
        if (node.maximum !== undefined) expect(value as number).toBeLessThanOrEqual(node.maximum as number);
      }
      if (node.type === "boolean") expect(typeof value).toBe("boolean");
    };
    if (sample.store !== undefined) check("store", sample.store);
    if (sample.retry) for (const [k, v] of Object.entries(sample.retry)) check(`retry.${k}`, v);
    if (sample.autoPrune) for (const [k, v] of Object.entries(sample.autoPrune)) check(`autoPrune.${k}`, v);
  });
});

describe("configJsonSchemaJson", () => {
  it("is pretty-printed valid JSON with a trailing newline", () => {
    const text = configJsonSchemaJson();
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain("\n  "); // 2-space indent
    const parsed = JSON.parse(text);
    expect(parsed).toEqual(buildConfigJsonSchema());
  });

  it("describes a schema the shipped sampleConfig round-trips through parseConfig", () => {
    // Not a full JSON Schema validation, but confirms the sample the CLI writes
    // is a structurally valid config the schema is meant to cover.
    expect(() => parseConfig(sampleConfig())).not.toThrow();
  });
});
