/**
 * Shared domain types for durable streams
 */
import { Schema } from "effect";

export const StreamPath = Schema.String.pipe(Schema.brand("StreamPath"));
export type StreamPath = typeof StreamPath.Type;

export const Offset = Schema.String.pipe(Schema.brand("Offset"));
export type Offset = typeof Offset.Type;

export const Payload = Schema.Record({ key: Schema.String, value: Schema.Unknown });
export type Payload = typeof Payload.Type;

export class Event extends Schema.Class<Event>("Event")({
  offset: Offset,
  payload: Payload,
}) {}
// { offset: "-1", payload: { type: } }
