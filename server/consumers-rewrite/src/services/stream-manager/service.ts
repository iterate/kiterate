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
    }) => Effect.Effect<Event, StreamStorageError>;

    /**
     * Subscribe to events on streams.
     * @param path - If provided, filter to this exact path. If omitted, get events from all streams.
     * @param after - Last seen offset (exclusive). Returns events with offset > after.
     * @param live - If true, continues with live events after history. Default: false (history only).
     */
    readonly subscribe: (input: {
      path?: StreamPath;
      after?: Offset;
      live?: boolean;
    }) => Stream.Stream<Event, StreamStorageError>;
  }
>() {}
