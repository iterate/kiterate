/**
 * StreamManager service definition
 */
import { Context, Effect, Stream } from "effect";

import { Event, EventInput, Offset, StreamPath } from "../../domain.js";
import { StreamStorageError } from "../stream-storage/service.js";

// -------------------------------------------------------------------------------------
// StreamManager service
// -------------------------------------------------------------------------------------

export class StreamManager extends Context.Tag("@app/StreamManager")<
  StreamManager,
  {
    readonly append: (input: {
      path: StreamPath;
      event: EventInput;
    }) => Effect.Effect<void, StreamStorageError>;

    /**
     * Subscribe to events on a stream.
     * @param from - Last seen offset (exclusive). Returns events with offset > from.
     * @param live - If true, continues with live events after history. Default: false (history only).
     */
    readonly subscribe: (input: {
      path: StreamPath;
      from?: Offset;
      live?: boolean;
    }) => Stream.Stream<Event, StreamStorageError>;
  }
>() {}
