/**
 * StreamClient service definition
 */
import { Context, Effect, Schema, Stream } from "effect";

import type { Event } from "../../domain.js";

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
    readonly subscribe: (path: string) => Stream.Stream<Event, StreamClientError>;
    readonly append: (
      path: string,
      event: Record<string, unknown>,
    ) => Effect.Effect<void, StreamClientError>;
  }
>() {}
