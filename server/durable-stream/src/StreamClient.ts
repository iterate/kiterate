/**
 * StreamClient - Effect service for consuming durable streams
 *
 * Platform-agnostic: provide NodeHttpClient.layer (CLI) or FetchHttpClient.layer (browser)
 */
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { Context, Effect, Layer, Stream } from "effect";

import type { Event } from "./DurableStreamManager.js";

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
    readonly subscribe: (path: string) => Stream.Stream<Event, Error>;
    readonly append: (path: string, event: Record<string, unknown>) => Effect.Effect<void, Error>;
  }
>() {}

// -------------------------------------------------------------------------------------
// Live implementation
// -------------------------------------------------------------------------------------

export const make = (config: StreamClientConfig) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    const subscribe = (path: string): Stream.Stream<Event, Error> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const response = yield* client.execute(
            HttpClientRequest.get(`${config.baseUrl}/agents/${path}`),
          );

          return response.stream.pipe(Stream.decodeText(), Stream.mapConcat(parseSSE));
        }).pipe(Effect.mapError((e) => new Error(`Subscribe failed: ${e}`))),
      );

    const append = (path: string, event: Record<string, unknown>) =>
      client
        .execute(
          HttpClientRequest.post(`${config.baseUrl}/agents/${path}`).pipe(
            HttpClientRequest.bodyUnsafeJson(event),
          ),
        )
        .pipe(
          Effect.asVoid,
          Effect.mapError((e) => new Error(`Append failed: ${e}`)),
        );

    return { subscribe, append };
  });

export const layer = (
  config: StreamClientConfig,
): Layer.Layer<StreamClient, never, HttpClient.HttpClient> =>
  Layer.effect(StreamClient, make(config));

// -------------------------------------------------------------------------------------
// SSE parsing
// -------------------------------------------------------------------------------------

function parseSSE(chunk: string): Array<Event> {
  const events: Array<Event> = [];
  const lines = chunk.split("\n");

  let currentEvent: string | null = null;
  let currentData: string | null = null;

  for (const line of lines) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7);
    } else if (line.startsWith("data: ")) {
      currentData = line.slice(6);
    } else if (line === "" && currentData !== null) {
      // Empty line = end of event
      if (currentEvent === "data") {
        try {
          events.push(JSON.parse(currentData) as Event);
        } catch {
          // Skip malformed JSON
        }
      }
      currentEvent = null;
      currentData = null;
    }
  }

  return events;
}
