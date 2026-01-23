/**
 * Tool Types
 *
 * Types for tools that can be invoked from codemode blocks.
 * Tools are fully serializable - including their implementation as a string.
 */
import { Option, Schema } from "effect";

// -------------------------------------------------------------------------------------
// Registered Tool
// -------------------------------------------------------------------------------------

/**
 * A registered tool with all data needed for execution.
 * Derived from ToolRegisteredEvent, stored in processor state.
 *
 * Tools are fully self-contained: the implementation is a JavaScript string
 * that follows similar rules to codemode blocks.
 */
export const RegisteredTool = Schema.Struct({
  /** Tool name - becomes the function name in codemode */
  name: Schema.String,
  /** Description for LLM */
  description: Schema.String,
  /** JSON Schema representation of parameters (for validation and LLM docs) */
  parametersJsonSchema: Schema.Unknown,
  /** Optional return description */
  returnDescription: Schema.OptionFromNullOr(Schema.String),
  /**
   * The tool implementation as a JavaScript string.
   * This is the body of an async function with `params` and ExecutionContext globals in scope.
   */
  implementation: Schema.String,
});
export type RegisteredTool = typeof RegisteredTool.Type;

// -------------------------------------------------------------------------------------
// Helper to create RegisteredTool from event payload
// -------------------------------------------------------------------------------------

/**
 * Create a RegisteredTool from a ToolRegisteredEvent payload.
 */
export const fromEventPayload = (payload: {
  name: string;
  description: string;
  parametersJsonSchema: unknown;
  returnDescription: Option.Option<string>;
  implementation: string;
}): RegisteredTool => ({
  name: payload.name,
  description: payload.description,
  parametersJsonSchema: payload.parametersJsonSchema,
  returnDescription: payload.returnDescription,
  implementation: payload.implementation,
});
