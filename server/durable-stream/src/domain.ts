/**
 * Shared domain types for durable streams
 */
import { Schema } from "effect";

// -------------------------------------------------------------------------------------
// Branded primitives
// -------------------------------------------------------------------------------------

export const StreamPath = Schema.String.pipe(Schema.brand("StreamPath"));
export type StreamPath = typeof StreamPath.Type;

export const Offset = Schema.String.pipe(Schema.brand("Offset"));
export type Offset = typeof Offset.Type;

export const EventType = Schema.String.pipe(Schema.brand("EventType"));
export type EventType = typeof EventType.Type;

export const Version = Schema.String.pipe(Schema.brand("Version"));
export type Version = typeof Version.Type;

export const Payload = Schema.Record({ key: Schema.String, value: Schema.Unknown });
export type Payload = typeof Payload.Type;

// -------------------------------------------------------------------------------------
// EventInput (base) -> Event (extended with offset + createdAt)
// -------------------------------------------------------------------------------------

/** Event input - what callers provide to append */
export class EventInput extends Schema.Class<EventInput>("EventInput")({
  type: EventType,
  payload: Payload,
  version: Schema.optionalWith(Version, { default: () => Version.make("1") }),
}) {}

/** Full event with offset and createdAt assigned by storage */
export class Event extends EventInput.extend<Event>("Event")({
  offset: Offset,
  createdAt: Schema.DateTimeUtc,
}) {}
