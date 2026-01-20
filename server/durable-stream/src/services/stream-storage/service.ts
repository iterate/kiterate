/**
 * StreamStorage service definition
 */
import { Context, Effect, Schema, Stream } from "effect";

import { Event, EventInput, Offset, StreamPath } from "../../domain.js";

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
    cause: Schema.Defect,
  },
) {}

// -------------------------------------------------------------------------------------
// StreamStorage interface + tag
// -------------------------------------------------------------------------------------

export interface StreamStorage {
  readonly [StreamStorageTypeId]: StreamStorageTypeId;
  /** Append event input to stream, assign offset + createdAt, store, and return the event */
  readonly append: (input: {
    path: StreamPath;
    event: EventInput;
  }) => Effect.Effect<Event, StreamStorageError>;
  /**
   * Read events from stream.
   * @param after - Last seen offset (exclusive). Returns events with offset > after.
   *                Pass the last offset you processed to resume without duplicates.
   */
  readonly read: (input: {
    path: StreamPath;
    after?: Offset;
  }) => Stream.Stream<Event, StreamStorageError>;
}

export const StreamStorage = Context.GenericTag<StreamStorage>("@app/StreamStorage");
