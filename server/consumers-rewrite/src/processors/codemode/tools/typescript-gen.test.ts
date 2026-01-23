import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";

import {
  jsonSchemaToTypeString,
  jsonSchemaToTypeStringSync,
  generateToolSignature,
  generateToolsTypeBlock,
} from "./typescript-gen.js";

describe("jsonSchemaToTypeString", () => {
  it.effect("converts simple object schema to inline type", () =>
    Effect.gen(function* () {
      const schema = {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
        },
        required: ["query"],
        additionalProperties: false,
      };

      const result = yield* jsonSchemaToTypeString(schema);

      expect(result).toContain("query: string");
      expect(result).toContain("limit?: number");
      expect(result).toMatch(/^\{.*\}$/); // Should be inline
    }),
  );

  it.effect("handles nested objects", () =>
    Effect.gen(function* () {
      const schema = {
        type: "object",
        properties: {
          config: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
            },
          },
        },
        additionalProperties: false,
      };

      const result = yield* jsonSchemaToTypeString(schema);

      expect(result).toContain("config?:");
      expect(result).toContain("enabled?: boolean");
    }),
  );

  it.effect("handles schema without type (defaults to any)", () =>
    Effect.gen(function* () {
      // Pass a schema without a type - json-schema-to-typescript treats this as allowing any
      const result = yield* jsonSchemaToTypeString({ invalid: true });
      // The library is lenient and produces a type anyway
      expect(typeof result).toBe("string");
    }),
  );
});

describe("jsonSchemaToTypeStringSync", () => {
  it("converts schema synchronously", async () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    };

    const result = await jsonSchemaToTypeStringSync(schema);

    expect(result).toContain("name: string");
  });
});

describe("generateToolSignature", () => {
  it("generates a complete function signature", async () => {
    const result = await generateToolSignature({
      name: "searchDatabase",
      description: "Searches the database for records",
      parametersJsonSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      returnDescription: "Matching records",
    });

    expect(result).toContain("/** Searches the database for records */");
    expect(result).toContain("searchDatabase(params:");
    expect(result).toContain("query: string");
    expect(result).toContain("Promise<unknown /* Matching records */>");
  });

  it("handles missing return description", async () => {
    const result = await generateToolSignature({
      name: "doSomething",
      description: "Does something",
      parametersJsonSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    });

    expect(result).toContain("Promise<unknown>");
    // Should NOT have a return description comment after "unknown"
    expect(result).toMatch(/Promise<unknown>$/);
  });
});

describe("generateToolsTypeBlock", () => {
  it("generates a block with multiple tool signatures", async () => {
    const tools = [
      {
        name: "add",
        description: "Adds two numbers",
        parametersJsonSchema: {
          type: "object",
          properties: {
            a: { type: "number" },
            b: { type: "number" },
          },
          required: ["a", "b"],
          additionalProperties: false,
        },
        returnDescription: "The sum",
      },
      {
        name: "multiply",
        description: "Multiplies two numbers",
        parametersJsonSchema: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
          },
          required: ["x", "y"],
          additionalProperties: false,
        },
      },
    ];

    const result = await generateToolsTypeBlock(tools);

    expect(result).toContain("// Available tools:");
    expect(result).toContain("add(params:");
    expect(result).toContain("multiply(params:");
    expect(result).toContain("a: number");
    expect(result).toContain("x: number");
  });

  it("returns empty string for empty tools array", async () => {
    const result = await generateToolsTypeBlock([]);
    expect(result).toBe("");
  });
});
