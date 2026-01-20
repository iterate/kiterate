/**
 * Integration tests: StreamClient against real server
 */
import { NodeHttpServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Scope } from "effect";

import { AppLive } from "./server.js";
import { InMemoryStreamManager } from "./StreamManager.js";
import { StreamClient, layer as StreamClientLayer } from "./StreamClient.js";
import { subscribeClient } from "./testing.js";

const TestLayer = Layer.merge(
  AppLive.pipe(Layer.provide(InMemoryStreamManager), Layer.provide(NodeHttpServer.layerTest)),
  StreamClientLayer({ baseUrl: "" }).pipe(Layer.provide(NodeHttpServer.layerTest)),
);

const test = <A, E>(name: string, effect: Effect.Effect<A, E, StreamClient | Scope.Scope>) =>
  it.live(name, () =>
    effect.pipe(Effect.timeout("2 seconds"), Effect.provide(TestLayer), Effect.scoped),
  );

describe("StreamClient", () => {
  test(
    "append and subscribe round-trip",
    Effect.gen(function* () {
      const client = yield* StreamClient;
      const { take } = yield* subscribeClient("test/roundtrip");

      yield* client.append("test/roundtrip", { message: "hello from client" });

      const event = yield* take;
      expect(event["message"]).toBe("hello from client");
    }),
  );

  test(
    "multiple events in sequence",
    Effect.gen(function* () {
      const client = yield* StreamClient;
      const { takeN } = yield* subscribeClient("test/sequence");

      yield* client.append("test/sequence", { n: 1 });
      yield* client.append("test/sequence", { n: 2 });
      yield* client.append("test/sequence", { n: 3 });

      const events = yield* takeN(3);
      expect(events.map((e) => e["n"])).toEqual([1, 2, 3]);
    }),
  );

  test(
    "different paths are independent",
    Effect.gen(function* () {
      const client = yield* StreamClient;
      const subA = yield* subscribeClient("test/path/a");
      const subB = yield* subscribeClient("test/path/b");

      yield* client.append("test/path/a", { source: "A" });

      const eventA = yield* subA.take;
      expect(eventA["source"]).toBe("A");

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
