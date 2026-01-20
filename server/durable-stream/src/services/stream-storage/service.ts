/**
 * StreamStorage service definition
 */
import { Context, Effect, Schema, Stream } from "effect";

import { Event, Offset, Payload, StreamPath } from "../../domain.js";

// -------------------------------------------------------------------------------------
// Type ID (for nominal uniqueness)
// -------------------------------------------------------------------------------------

export const StreamStorageTypeId: unique symbol = Symbol.for("@app/StreamStorage");
export type StreamStorageTypeId = typeof StreamStorageTypeId;

// -------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------

export class StreamStorageError extends Schema.TaggedError<StreamStorageError>()(
  "StreamStorageError",
  {
    cause: Schema.Unknown,
  },
) {}

// -------------------------------------------------------------------------------------
// StreamStorage interface + tag
// -------------------------------------------------------------------------------------

export interface StreamStorage {
  readonly [StreamStorageTypeId]: StreamStorageTypeId;
  /** Append payload to stream, assign offset, store, and return the event */
  readonly append: (input: {
    path: StreamPath;
    payload: Payload;
  }) => Effect.Effect<Event, StreamStorageError>;
  /** Read events from stream as a stream, optionally starting from an offset */
  readonly read: (input: {
    path: StreamPath;
    from?: Offset;
  }) => Stream.Stream<Event, StreamStorageError>;
}

export const StreamStorage = Context.GenericTag<StreamStorage>("@app/StreamStorage");
