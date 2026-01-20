/**
 * StreamClient service definition
 */
import { Context, Effect, Schema, Stream } from "effect";

import type { Event, EventInput, Offset, StreamPath } from "../../domain.js";

// -------------------------------------------------------------------------------------
// Errors
// -------------------------------------------------------------------------------------

export class StreamClientError extends Schema.TaggedError<StreamClientError>()(
  "StreamClientError",
  {
    operation: Schema.Literal("subscribe", "append"),
    cause: Schema.Defect,
  },
) {}

// -------------------------------------------------------------------------------------
// Service definition
// -------------------------------------------------------------------------------------

export interface StreamClientConfig {
  /** Base URL for the server. Use empty string if HttpClient is already configured (e.g., from layerTest) */
  readonly baseUrl: string;
}

export class StreamClient extends Context.Tag("@app/StreamClient")<
  StreamClient,
  {
    /**
     * Subscribe to events on a stream.
     * @param from - Last seen offset (exclusive). Returns events with offset > from.
     * @param live - If true, continues with live events after history. Default: false (history only).
     */
    readonly subscribe: (input: {
      path: StreamPath;
      from?: Offset;
      live?: boolean;
    }) => Stream.Stream<Event, StreamClientError>;

    readonly append: (input: {
      path: StreamPath;
      event: EventInput;
    }) => Effect.Effect<void, StreamClientError>;
  }
>() {}
