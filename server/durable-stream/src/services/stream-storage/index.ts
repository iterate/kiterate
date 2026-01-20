/**
 * StreamStorage - pluggable storage backend for durable streams
 */
import { Context, Effect, Stream } from "effect";

import { Event, Offset, Payload, StreamPath } from "../../domain.js";

// -------------------------------------------------------------------------------------
// StreamStorage interface
// -------------------------------------------------------------------------------------

export interface StreamStorage {
  /** Append payload to stream, assign offset, store, and return the event */
  readonly append: (input: { path: StreamPath; payload: Payload }) => Effect.Effect<Event>;
  /** Read events from stream as a stream, optionally starting from an offset */
  readonly read: (input: { path: StreamPath; from?: Offset }) => Stream.Stream<Event>;
}

// -------------------------------------------------------------------------------------
// StreamStorageService
// -------------------------------------------------------------------------------------

export class StreamStorageService extends Context.Tag("@app/StreamStorageService")<
  StreamStorageService,
  StreamStorage
>() {}
