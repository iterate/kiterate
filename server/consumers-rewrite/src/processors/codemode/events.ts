/**
 * Codemode Processor Events
 *
 * Events emitted by the Codemode processor during code evaluation lifecycle.
 */
import { Schema } from "effect";

import { EventSchema } from "../../events.js";

// -------------------------------------------------------------------------------------
// Branded Types
// -------------------------------------------------------------------------------------

/**
 * RequestId for correlating codemode events.
 * Format: `${offset}.${indexOfCodeBlock}` where indexOfCodeBlock is the index
 * of the <codemode> block within the assistant message (usually 0).
 */
export const RequestId = Schema.String.pipe(Schema.brand("CodemodeRequestId"));
export type RequestId = typeof RequestId.Type;

// -------------------------------------------------------------------------------------
// Log Entry
// -------------------------------------------------------------------------------------

/** A captured console.log call - stored as plain object for JSON serialization */
export const LogEntry = Schema.Struct({
  level: Schema.Literal("info", "error", "warn", "debug"),
  args: Schema.Array(Schema.Unknown),
  /** ISO timestamp string */
  timestamp: Schema.String,
});
export type LogEntry = typeof LogEntry.Type;

// -------------------------------------------------------------------------------------
// Code Lifecycle Events
// -------------------------------------------------------------------------------------

/** Emitted when a <codemode> block is parsed from an assistant message */
export const CodeBlockAddedEvent = EventSchema.make("iterate:codemode:code-block-added", {
  requestId: RequestId,
  code: Schema.String,
});

/** Emitted when code evaluation begins */
export const CodeEvalStartedEvent = EventSchema.make("iterate:codemode:code-eval-started", {
  requestId: RequestId,
});

/** Emitted when code evaluation completes successfully */
export const CodeEvalDoneEvent = EventSchema.make("iterate:codemode:code-eval-done", {
  requestId: RequestId,
  data: Schema.String,
  logs: Schema.Array(LogEntry),
});

/** Emitted when code evaluation fails */
export const CodeEvalFailedEvent = EventSchema.make("iterate:codemode:code-eval-failed", {
  requestId: RequestId,
  error: Schema.String,
  logs: Schema.Array(LogEntry),
});

// -------------------------------------------------------------------------------------
// Tool Registration Events
// -------------------------------------------------------------------------------------

/**
 * Emitted when a tool is registered and available for use in codemode blocks.
 *
 * Tools are fully self-contained: the implementation is a JavaScript string
 * that follows similar rules to codemode blocks. The implementation is the
 * body of an async function that receives:
 * - `params` - the validated parameters (validated against parametersJsonSchema)
 * - `fetch`, `execa`, `console`, `process`, `require` from ExecutionContext
 *
 * Example implementation: `return await fetch(params.url).then(r => r.json());`
 */
export const ToolRegisteredEvent = EventSchema.make("iterate:codemode:tool-registered", {
  /** Unique tool name - becomes the function name in codemode */
  name: Schema.String,
  /** Human-readable description for the LLM */
  description: Schema.String,
  /** JSON Schema representation of parameters (for LLM documentation and validation) */
  parametersJsonSchema: Schema.Unknown,
  /** Optional description of return value */
  returnDescription: Schema.OptionFromNullOr(Schema.String),
  /**
   * The tool implementation as a JavaScript string.
   * This is the body of an async function with `params` and ExecutionContext globals in scope.
   */
  implementation: Schema.String,
});

/** Emitted when a tool is unregistered and no longer available */
export const ToolUnregisteredEvent = EventSchema.make("iterate:codemode:tool-unregistered", {
  /** Name of the tool to unregister */
  name: Schema.String,
});

// -------------------------------------------------------------------------------------
// Deferred Block Events
// -------------------------------------------------------------------------------------

/**
 * Emitted when a deferred block is registered for periodic polling.
 *
 * Deferred blocks are generic codemode blocks that run periodically until they
 * return a truthy value or throw. This is useful for long-running tasks like
 * deep research that need to poll for completion.
 *
 * Convention:
 * - Return null/falsy = keep polling
 * - Return truthy = done (result emitted as synthetic user message)
 * - Throw = done with error
 *
 * The block's identity is the offset of this event (not a separate ID field).
 */
export const DeferredBlockAddedEvent = EventSchema.make("iterate:codemode:deferred-block-added", {
  /** JavaScript code to run periodically (same rules as codemode blocks) */
  code: Schema.String,
  /** How often to check, in seconds */
  checkIntervalSeconds: Schema.Number,
  /** Maximum number of poll attempts before timing out */
  maxAttempts: Schema.Number,
  /** Human-readable description for LLM/user visibility */
  description: Schema.String,
});
export type DeferredBlockAddedEvent = typeof DeferredBlockAddedEvent.Type;

/**
 * Emitted each time a deferred block is polled.
 */
export const DeferredPollAttemptedEvent = EventSchema.make(
  "iterate:codemode:deferred-poll-attempted",
  {
    /** Offset of the DeferredBlockAddedEvent */
    blockOffset: Schema.String,
    /** 1-indexed attempt number */
    attemptNumber: Schema.Number,
    /** Seconds elapsed since stream start when this poll occurred */
    elapsedSeconds: Schema.Number,
    /** The result of the poll (null if still pending, stringified value if done) */
    result: Schema.NullOr(Schema.String),
    /** Console logs captured during this poll */
    logs: Schema.Array(LogEntry),
  },
);
export type DeferredPollAttemptedEvent = typeof DeferredPollAttemptedEvent.Type;

/**
 * Emitted when a deferred block completes successfully (returned truthy).
 */
export const DeferredCompletedEvent = EventSchema.make("iterate:codemode:deferred-completed", {
  /** Offset of the DeferredBlockAddedEvent */
  blockOffset: Schema.String,
  /** The final result (stringified) */
  result: Schema.String,
});
export type DeferredCompletedEvent = typeof DeferredCompletedEvent.Type;

/**
 * Emitted when a deferred block fails (threw an error).
 */
export const DeferredFailedEvent = EventSchema.make("iterate:codemode:deferred-failed", {
  /** Offset of the DeferredBlockAddedEvent */
  blockOffset: Schema.String,
  /** The error message */
  error: Schema.String,
});
export type DeferredFailedEvent = typeof DeferredFailedEvent.Type;

/**
 * Emitted when a deferred block times out (exceeded maxAttempts).
 */
export const DeferredTimedOutEvent = EventSchema.make("iterate:codemode:deferred-timed-out", {
  /** Offset of the DeferredBlockAddedEvent */
  blockOffset: Schema.String,
  /** Total number of attempts made */
  attempts: Schema.Number,
});
export type DeferredTimedOutEvent = typeof DeferredTimedOutEvent.Type;

/**
 * Emitted when a deferred block is cancelled (e.g., by user request).
 */
export const DeferredCancelledEvent = EventSchema.make("iterate:codemode:deferred-cancelled", {
  /** Offset of the DeferredBlockAddedEvent */
  blockOffset: Schema.String,
  /** Optional reason for cancellation */
  reason: Schema.OptionFromNullOr(Schema.String),
});
export type DeferredCancelledEvent = typeof DeferredCancelledEvent.Type;
