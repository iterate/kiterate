/**
 * TypeScript Code Generation from JSON Schema
 *
 * Generates TypeScript type strings from JSON Schema for LLM documentation.
 */
import { compileSync, type JSONSchema } from "@mmkal/json-schema-to-typescript";

// -------------------------------------------------------------------------------------
// JSON Schema to TypeScript
// -------------------------------------------------------------------------------------

/**
 * Convert a JSON Schema to a TypeScript inline type string.
 * For example: `{ query: string; maxResults?: number }`
 *
 * Returns `unknown` if conversion fails.
 */
export const jsonSchemaToTypeString = (schema: unknown): string => {
  try {
    const jsonSchema = schema as JSONSchema;

    const fullInterface = compileSync(jsonSchema, "Params", {
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
export const generateToolSignature = (tool: {
  name: string;
  description: string;
  parametersJsonSchema: unknown;
  returnDescription?: string | undefined;
}): string => {
  const paramsType = jsonSchemaToTypeString(tool.parametersJsonSchema);
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
export const generateToolsTypeBlock = (
  tools: ReadonlyArray<{
    name: string;
    description: string;
    parametersJsonSchema: unknown;
    returnDescription?: string;
  }>,
): string => {
  if (tools.length === 0) {
    return "";
  }

  const signatures = tools.map(generateToolSignature);

  return `// Available tools:\n\n${signatures.join("\n\n")}`;
};
