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
