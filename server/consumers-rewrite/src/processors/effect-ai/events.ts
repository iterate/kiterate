/**
 * Effect AI Processor Events
 *
 * Events emitted by the Effect AI processor during LLM request lifecycle.
 */
import { Response } from "@effect/ai";
import { Option, Schema } from "effect";

import { Offset } from "../../domain.js";
import { EventSchema } from "../../events.js";

// -------------------------------------------------------------------------------------
// Request Lifecycle Events
// -------------------------------------------------------------------------------------

export const RequestStartedEvent = EventSchema.make("iterate:effect-ai:request-started", {});

const _ResponseSseEvent = EventSchema.make("iterate:effect-ai:response:sse", {
  part: Schema.Unknown,
  requestOffset: Offset,
});

const decodeTextDelta = Schema.decodeUnknownOption(Response.TextDeltaPart);

export const ResponseSseEvent = Object.assign(_ResponseSseEvent, {
  /** Decode the part as a TextDeltaPart, if applicable */
  decodeTextDelta: (part: unknown): Option.Option<Response.TextDeltaPart> => decodeTextDelta(part),
});

export const RequestEndedEvent = EventSchema.make("iterate:effect-ai:request-ended", {
  requestOffset: Offset,
});

export const RequestCancelledEvent = EventSchema.make("iterate:effect-ai:request-cancelled", {
  requestOffset: Offset,
  reason: Schema.String,
  message: Schema.String,
});

export const RequestInterruptedEvent = EventSchema.make("iterate:effect-ai:request-interrupted", {
  requestOffset: Schema.NullOr(Offset),
});
