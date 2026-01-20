/**
 * Live implementation of StreamClient
 */
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { Effect, Layer, Stream } from "effect";

import type { Event, EventInput } from "../../domain.js";
import { StreamClient, StreamClientConfig, StreamClientError } from "./service.js";

// -------------------------------------------------------------------------------------
// Live implementation
// -------------------------------------------------------------------------------------

export const make = (config: StreamClientConfig) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    const subscribe = (path: string): Stream.Stream<Event, StreamClientError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const response = yield* client.execute(
            HttpClientRequest.get(`${config.baseUrl}/agents/${path}`),
          );

          return response.stream.pipe(
            Stream.mapError((cause) => StreamClientError.make({ operation: "subscribe", cause })),
            Stream.decodeText(),
            Stream.mapConcat(parseSSE),
          );
        }).pipe(
          Effect.mapError((cause) => StreamClientError.make({ operation: "subscribe", cause })),
        ),
      );

    const append = (path: string, event: EventInput) =>
      client
        .execute(
          HttpClientRequest.post(`${config.baseUrl}/agents/${path}`).pipe(
            HttpClientRequest.bodyUnsafeJson(event),
          ),
        )
        .pipe(
          Effect.asVoid,
          Effect.mapError((cause) => StreamClientError.make({ operation: "append", cause })),
        );

    return { subscribe, append };
  });

export const liveLayer = (
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
