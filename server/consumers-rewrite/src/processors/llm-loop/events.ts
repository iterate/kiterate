/**
 * LLM Loop Processor Events
 *
 * Events emitted by the LLM Loop processor during LLM request lifecycle.
 */
import { Response } from "@effect/ai";
import { Option, Schema } from "effect";

import { Offset } from "../../domain.js";
import { EventSchema } from "../../events.js";

// -------------------------------------------------------------------------------------
// Request Lifecycle Events
// -------------------------------------------------------------------------------------

export const RequestStartedEvent = EventSchema.make("iterate:llm-loop:request-started", {});

const _ResponseSseEvent = EventSchema.make("iterate:llm-loop:response:sse", {
  part: Schema.Unknown,
  requestOffset: Offset,
});

const decodeTextDelta = Schema.decodeUnknownOption(Response.TextDeltaPart);

export const ResponseSseEvent = Object.assign(_ResponseSseEvent, {
  /** Decode the part as a TextDeltaPart, if applicable */
  decodeTextDelta: (part: unknown): Option.Option<Response.TextDeltaPart> => decodeTextDelta(part),
});

export const RequestEndedEvent = EventSchema.make("iterate:llm-loop:request-ended", {
  requestOffset: Offset,
});

export const RequestCancelledEvent = EventSchema.make("iterate:llm-loop:request-cancelled", {
  requestOffset: Offset,
  reason: Schema.String,
  message: Schema.String,
});

export const RequestInterruptedEvent = EventSchema.make("iterate:llm-loop:request-interrupted", {
  requestOffset: Schema.NullOr(Offset),
});

// -------------------------------------------------------------------------------------
// Activation Event
// -------------------------------------------------------------------------------------

/** Emitted when the LLM loop processor is activated (e.g., when a model is configured) */
export const LlmLoopActivatedEvent = EventSchema.make("iterate:llm-loop:activated", {});

// -------------------------------------------------------------------------------------
// System Prompt Events
// -------------------------------------------------------------------------------------

/** Edit the system prompt used by the LLM loop */
export const SystemPromptEditEvent = EventSchema.make("iterate:llm-loop:system-prompt-edit", {
  /** How to apply the edit */
  mode: Schema.Literal("append", "replace", "prepend"),
  /** The content to add/replace */
  content: Schema.String,
  /** Optional source identifier for debugging */
  source: Schema.optionalWith(Schema.String, { as: "Option" }),
});
