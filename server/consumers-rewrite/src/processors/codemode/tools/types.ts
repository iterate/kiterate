/**
 * Tool Definition Types
 *
 * Types for defining tools that can be invoked from codemode blocks.
 */
import { JSONSchema, Option, Schema } from "effect";

// -------------------------------------------------------------------------------------
// Tool Definition
// -------------------------------------------------------------------------------------

/**
 * Defines a tool that can be called from codemode blocks.
 *
 * @template P - The parameter schema type
 * @template R - The return type
 */
export interface ToolDefinition<P = unknown, R = unknown> {
  /** Unique tool name - becomes the function name in codemode */
  readonly name: string;
  /** Human-readable description for the LLM */
  readonly description: string;
  /** Effect Schema for parameters - used for validation and LLM documentation */
  readonly parameters: Schema.Schema<P>;
  /** Optional description of return value */
  readonly returnDescription?: string;
  /** The actual implementation */
  readonly execute: (params: P) => Promise<R>;
}

/**
 * Type-safe helper to define a tool with full type inference.
 */
export const defineTool = <P, R>(definition: ToolDefinition<P, R>): ToolDefinition<P, R> =>
  definition;

// -------------------------------------------------------------------------------------
// Registered Tool Metadata
// -------------------------------------------------------------------------------------

/**
 * Metadata about a registered tool (stored in state, derived from events).
 * Does NOT include the implementation - that lives in the ToolRegistry service.
 */
export const RegisteredToolMeta = Schema.Struct({
  /** Tool name */
  name: Schema.String,
  /** Description for LLM */
  description: Schema.String,
  /** JSON Schema representation of parameters */
  parametersJsonSchema: Schema.Unknown,
  /** Optional return description */
  returnDescription: Schema.OptionFromNullOr(Schema.String),
});
export type RegisteredToolMeta = typeof RegisteredToolMeta.Type;

// -------------------------------------------------------------------------------------
// Schema Utilities
// -------------------------------------------------------------------------------------

/**
 * Convert an Effect Schema to JSON Schema for LLM documentation.
 */
export const toJsonSchema = <A, I, R>(schema: Schema.Schema<A, I, R>): object => {
  return JSONSchema.make(schema);
};

/**
 * Create RegisteredToolMeta from a ToolDefinition.
 */
export const toolDefinitionToMeta = <P, R>(tool: ToolDefinition<P, R>): RegisteredToolMeta => ({
  name: tool.name,
  description: tool.description,
  parametersJsonSchema: toJsonSchema(tool.parameters),
  returnDescription: Option.fromNullable(tool.returnDescription),
});
