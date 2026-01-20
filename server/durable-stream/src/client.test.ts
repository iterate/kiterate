/**
 * Integration tests: StreamClient against real server
 */
import { NodeHttpServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Chunk, Effect, Fiber, Layer, Scope, Stream } from "effect";

import { AppLive } from "./server.js";
import { InMemoryStreamManager } from "./StreamManager.js";
import { StreamClient, layer as StreamClientLayer } from "./StreamClient.js";

const TestLayer = Layer.merge(
  AppLive.pipe(Layer.provide(InMemoryStreamManager), Layer.provide(NodeHttpServer.layerTest)),
  StreamClientLayer({ baseUrl: "" }).pipe(Layer.provide(NodeHttpServer.layerTest)),
);

const test = <A, E>(name: string, effect: Effect.Effect<A, E, StreamClient | Scope.Scope>) =>
  it.live(name, () =>
    effect.pipe(Effect.timeout("2 seconds"), Effect.provide(TestLayer), Effect.scoped),
  );

const subscribe = (path: string, count: number) =>
  Effect.gen(function* () {
    const client = yield* StreamClient;
    return yield* client.subscribe(path).pipe(Stream.take(count), Stream.runCollect, Effect.fork);
  });

describe("StreamClient", () => {
  test(
    "append and subscribe round-trip",
    Effect.gen(function* () {
      const client = yield* StreamClient;
      const fiber = yield* subscribe("test/roundtrip", 1);

      yield* Effect.sleep("10 millis");
      yield* client.append("test/roundtrip", { message: "hello from client" });

      const events = Chunk.toReadonlyArray(yield* Fiber.join(fiber));
      expect(events).toHaveLength(1);
      expect(events[0]["message"]).toBe("hello from client");
    }),
  );

  test(
    "multiple events in sequence",
    Effect.gen(function* () {
      const client = yield* StreamClient;
      const fiber = yield* subscribe("test/sequence", 3);

      yield* Effect.sleep("10 millis");
      yield* client.append("test/sequence", { n: 1 });
      yield* client.append("test/sequence", { n: 2 });
      yield* client.append("test/sequence", { n: 3 });

      const events = Chunk.toReadonlyArray(yield* Fiber.join(fiber));
      expect(events).toHaveLength(3);
      expect(events.map((e) => e["n"])).toEqual([1, 2, 3]);
    }),
  );

  test(
    "different paths are independent",
    Effect.gen(function* () {
      const client = yield* StreamClient;
      const fiberA = yield* subscribe("test/path/a", 1);
      const fiberB = yield* subscribe("test/path/b", 1);

      yield* Effect.sleep("10 millis");
      yield* client.append("test/path/a", { source: "A" });

      const eventsA = Chunk.toReadonlyArray(yield* Fiber.join(fiberA));
      expect(eventsA[0]["source"]).toBe("A");

      const resultB = yield* Fiber.join(fiberB).pipe(
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
