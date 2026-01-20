/**
 * Integration tests: StreamClient against real server
 */
import { NodeHttpServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Chunk, Effect, Fiber, Layer, Stream } from "effect";

import { AppLive } from "./server.js";
import { InMemoryStreamManager } from "./StreamManager.js";
import { StreamClient, layer as StreamClientLayer } from "./StreamClient.js";

const TestLayer = Layer.merge(
  AppLive.pipe(Layer.provide(InMemoryStreamManager), Layer.provide(NodeHttpServer.layerTest)),
  StreamClientLayer({ baseUrl: "" }).pipe(Layer.provide(NodeHttpServer.layerTest)),
);

const test = <A, E>(name: string, effect: Effect.Effect<A, E, StreamClient>) =>
  it.live(name, () =>
    effect.pipe(Effect.timeout("2 seconds"), Effect.provide(TestLayer), Effect.scoped),
  );

const subscribe = (path: string, count: number) =>
  Effect.gen(function* () {
    const client = yield* StreamClient;
    return yield* client.subscribe(path).pipe(Stream.take(count), Stream.runCollect);
  }).pipe(Effect.fork);

describe("StreamClient", () => {
  test(
    "append and subscribe round-trip",
    Effect.gen(function* () {
      const client = yield* StreamClient;

      const subscriberFiber = yield* subscribe("test/roundtrip", 1);

      yield* Effect.sleep("100 millis");
      yield* client.append("test/roundtrip", { message: "hello from client" });

      const events = yield* Fiber.join(subscriberFiber);
      const arr = Chunk.toReadonlyArray(events);

      expect(arr).toHaveLength(1);
      expect((arr[0] as unknown as { message: string }).message).toBe("hello from client");
    }),
  );

  test(
    "multiple events in sequence",
    Effect.gen(function* () {
      const client = yield* StreamClient;

      const subscriberFiber = yield* subscribe("test/sequence", 3);

      yield* Effect.sleep("100 millis");
      yield* client.append("test/sequence", { n: 1 });
      yield* client.append("test/sequence", { n: 2 });
      yield* client.append("test/sequence", { n: 3 });

      const events = yield* Fiber.join(subscriberFiber);
      const arr = Chunk.toReadonlyArray(events);

      expect(arr).toHaveLength(3);
      expect(arr.map((event) => (event as unknown as { n: number }).n)).toEqual([1, 2, 3]);
    }),
  );

  test(
    "different paths are independent",
    Effect.gen(function* () {
      const client = yield* StreamClient;

      const subscriberA = yield* subscribe("test/path/a", 1);
      const subscriberB = yield* subscribe("test/path/b", 1);

      yield* Effect.sleep("100 millis");
      yield* client.append("test/path/a", { source: "A" });

      const eventsA = yield* Fiber.join(subscriberA);
      const dataA = Chunk.toReadonlyArray(eventsA)[0];
      expect((dataA as unknown as { source: string }).source).toBe("A");

      const resultB = yield* Fiber.join(subscriberB).pipe(
        Effect.timeoutTo({
          duration: "100 millis",
          onSuccess: () => "received",
          onTimeout: () => "timeout",
        }),
      );
      expect(resultB).toBe("timeout");
    }),
  );
});
