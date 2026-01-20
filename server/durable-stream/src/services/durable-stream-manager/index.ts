/**
 * DurableStreamManager - Event streaming with replay support
 */
import { Context, Effect, Stream } from "effect";

import { Event, Offset, Payload, StreamPath } from "../../domain.js";
import { StreamStorage, StreamStorageError } from "../stream-storage/index.js";

// -------------------------------------------------------------------------------------
// DurableIterateStream - single stream with history and replay
// -------------------------------------------------------------------------------------

export interface DurableIterateStream {
  readonly append: (input: { payload: Payload }) => Effect.Effect<void, StreamStorageError>;
  /** Subscribe with optional offset. live=false (default) for historical only, live=true for live only */
  readonly subscribe: (options?: {
    from?: Offset;
    live?: boolean;
  }) => Stream.Stream<Event, StreamStorageError>;
}

export { StreamStorageError };
export type { StreamStorage };

// -------------------------------------------------------------------------------------
// DurableStreamManager service
// -------------------------------------------------------------------------------------

export class DurableStreamManager extends Context.Tag("@app/DurableStreamManager")<
  DurableStreamManager,
  {
    readonly append: (input: {
      path: StreamPath;
      payload: Payload;
    }) => Effect.Effect<void, StreamStorageError>;
    readonly subscribe: (input: {
      path: StreamPath;
      from?: Offset;
      live?: boolean;
    }) => Stream.Stream<Event, StreamStorageError>;
  }
>() {}
