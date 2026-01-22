/**
 * Integration tests: StreamClient against real server
 */
import { NodeHttpServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Scope } from "effect";

import { EventInput, EventType, StreamPath } from "./domain.js";
import { AppLive } from "./server.js";
import * as StreamClient from "./services/stream-client/index.js";
import * as StreamManager from "./services/stream-manager/index.js";
import * as StreamStorage from "./services/stream-storage/index.js";
import { subscribeClient } from "./testing.js";

const testLayer = Layer.merge(
  AppLive.pipe(
    Layer.provide(StreamManager.liveLayer),
    Layer.provide(StreamStorage.inMemoryLayer),
    Layer.provide(NodeHttpServer.layerTest),
  ),
  StreamClient.liveLayer({ baseUrl: "" }).pipe(Layer.provide(NodeHttpServer.layerTest)),
);

const test = <A, E>(
  name: string,
  effect: Effect.Effect<A, E, StreamClient.StreamClient | Scope.Scope>,
) =>
  it.live(name, () =>
    effect.pipe(Effect.timeout("2 seconds"), Effect.provide(testLayer), Effect.scoped),
  );

describe("StreamClient", () => {
  test(
    "append and subscribe round-trip",
    Effect.gen(function* () {
      const client = yield* StreamClient.StreamClient;
      const path = StreamPath.make("test/roundtrip");
      const { take } = yield* subscribeClient(path);

      yield* client.append({
        path,
        event: EventInput.make({
          type: EventType.make("test"),
          payload: { message: "hello from client" },
        }),
      });

      const event = yield* take;
      expect(event.payload["message"]).toBe("hello from client");
    }),
  );

  test(
    "multiple events in sequence",
    Effect.gen(function* () {
      const client = yield* StreamClient.StreamClient;
      const path = StreamPath.make("test/sequence");
      const { takeN } = yield* subscribeClient(path);

      yield* client.append({
        path,
        event: EventInput.make({ type: EventType.make("test"), payload: { n: 1 } }),
      });
      yield* client.append({
        path,
        event: EventInput.make({ type: EventType.make("test"), payload: { n: 2 } }),
      });
      yield* client.append({
        path,
        event: EventInput.make({ type: EventType.make("test"), payload: { n: 3 } }),
      });

      const events = yield* takeN(3);
      expect(events.map((e) => e.payload["n"])).toEqual([1, 2, 3]);
    }),
  );

  test(
    "different paths are independent",
    Effect.gen(function* () {
      const client = yield* StreamClient.StreamClient;
      const pathA = StreamPath.make("test/path/a");
      const pathB = StreamPath.make("test/path/b");
      const subA = yield* subscribeClient(pathA);
      const subB = yield* subscribeClient(pathB);

      yield* client.append({
        path: pathA,
        event: EventInput.make({ type: EventType.make("test"), payload: { source: "A" } }),
      });

      const eventA = yield* subA.take;
      expect(eventA.payload["source"]).toBe("A");

      const resultB = yield* subB.take.pipe(
        Effect.timeoutTo({
          duration: "50 millis",
          onSuccess: () => "received",
          onTimeout: () => "timeout",
        }),
      );
      expect(resultB).toBe("timeout");
    }),
  );
});
