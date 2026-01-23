/**
 * TypeScript Code Generation from JSON Schema
 *
 * Generates TypeScript type strings from JSON Schema for LLM documentation.
 */
import { compile, type JSONSchema } from "json-schema-to-typescript";
import { Effect } from "effect";

// -------------------------------------------------------------------------------------
// JSON Schema to TypeScript
// -------------------------------------------------------------------------------------

/**
 * Convert a JSON Schema to a TypeScript inline type string.
 * For example: `{ query: string; maxResults?: number }`
 *
 * Returns a fallback `unknown` type if conversion fails.
 */
export const jsonSchemaToTypeString = (schema: unknown): Effect.Effect<string> =>
  Effect.gen(function* () {
    try {
      // Ensure we have a valid object type schema
      const jsonSchema = schema as JSONSchema;

      // Use json-schema-to-typescript to generate the interface
      const fullInterface = yield* Effect.promise(() =>
        compile(jsonSchema, "Params", {
          bannerComment: "",
          declareExternallyReferenced: false,
          additionalProperties: false,
          unknownAny: false,
        }),
      );

      // Extract just the type body (remove "export interface Params" wrapper)
      // Input:  "export interface Params {\n  query: string;\n  maxResults?: number;\n}\n"
      // Output: "{ query: string; maxResults?: number }"
      const typeBody = extractTypeBody(fullInterface);
      return typeBody;
    } catch (error) {
      yield* Effect.logWarning(`Failed to convert JSON Schema to TypeScript: ${error}`);
      return "unknown";
    }
  });

/**
 * Synchronous version that returns a Promise (for use in non-Effect code).
 */
export const jsonSchemaToTypeStringSync = async (schema: unknown): Promise<string> => {
  try {
    const jsonSchema = schema as JSONSchema;

    const fullInterface = await compile(jsonSchema, "Params", {
      bannerComment: "",
      declareExternallyReferenced: false,
      additionalProperties: false,
      unknownAny: false,
    });

    return extractTypeBody(fullInterface);
  } catch {
    return "unknown";
  }
};

/**
 * Extract the type body from a full interface declaration.
 * Converts multi-line interface to single-line inline type.
 */
const extractTypeBody = (fullInterface: string): string => {
  // Remove "export interface Params " prefix
  const match = fullInterface.match(/interface\s+\w+\s*(\{[\s\S]*\})/);
  if (!match) {
    return "unknown";
  }

  // Get the body and convert to single line
  let body = match[1];

  // Remove newlines and collapse whitespace
  body = body.replace(/\n/g, " ").replace(/\s+/g, " ").trim();

  // Clean up spacing around braces and semicolons
  body = body.replace(/\{\s+/g, "{ ").replace(/\s+\}/g, " }").replace(/;\s+/g, "; ");

  return body;
};

// -------------------------------------------------------------------------------------
// Tool Signature Generation
// -------------------------------------------------------------------------------------

/**
 * Generate a TypeScript function signature for a tool.
 *
 * Example output:
 * ```
 * /** Performs deep research on a topic *\/
 * deepResearch(params: { query: string }): Promise<unknown>
 * ```
 */
export const generateToolSignature = async (tool: {
  name: string;
  description: string;
  parametersJsonSchema: unknown;
  returnDescription?: string | undefined;
}): Promise<string> => {
  const paramsType = await jsonSchemaToTypeStringSync(tool.parametersJsonSchema);
  const returnComment = tool.returnDescription ? ` /* ${tool.returnDescription} */` : "";

  return `/** ${tool.description} */\n${tool.name}(params: ${paramsType}): Promise<unknown${returnComment}>`;
};

/**
 * Generate a TypeScript declarations block for multiple tools.
 *
 * Example output:
 * ```typescript
 * // Available tools:
 *
 * /** Performs deep research on a topic *\/
 * deepResearch(params: { query: string }): Promise<unknown>
 *
 * /** Adds two numbers together *\/
 * add(params: { a: number; b: number }): Promise<unknown /* The sum *\/>
 * ```
 */
export const generateToolsTypeBlock = async (
  tools: ReadonlyArray<{
    name: string;
    description: string;
    parametersJsonSchema: unknown;
    returnDescription?: string;
  }>,
): Promise<string> => {
  if (tools.length === 0) {
    return "";
  }

  const signatures = await Promise.all(tools.map(generateToolSignature));

  return `// Available tools:\n\n${signatures.join("\n\n")}`;
};
