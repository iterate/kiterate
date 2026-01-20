/**
 * StreamManager service definition
 */
import { Context, Effect, Stream } from "effect";

import { Event, Offset, Payload, StreamPath } from "../../domain.js";
import { StreamStorageError } from "../stream-storage/service.js";

// -------------------------------------------------------------------------------------
// StreamManager service
// -------------------------------------------------------------------------------------

export class StreamManager extends Context.Tag("@app/StreamManager")<
  StreamManager,
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
