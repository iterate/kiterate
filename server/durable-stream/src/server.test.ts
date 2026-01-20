import { HttpClient, HttpClientRequest } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Chunk, Effect, Fiber, Layer, Stream } from "effect";

import { AppLive } from "./server.js";
import { InMemoryStreamManager } from "./StreamManager.js";

const TestLayer = Layer.merge(
  AppLive.pipe(Layer.provide(InMemoryStreamManager), Layer.provide(NodeHttpServer.layerTest)),
  NodeHttpServer.layerTest,
);

// Test helper: wraps it.live with timeout, layer, and scope
const test = <A, E>(name: string, effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
  it.live(name, () => effect.pipe(Effect.timeout("500 millis"), Effect.provide(TestLayer), Effect.scoped));

// Helper: subscribe to SSE stream, returns fiber
const subscribe = (path: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(HttpClientRequest.get(path));
    return yield* response.stream.pipe(Stream.decodeText(), Stream.take(1), Stream.runCollect);
  }).pipe(Effect.fork);

// Helper: post JSON to path
const post = (path: string, body: unknown) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    yield* client.execute(
      HttpClientRequest.post(path).pipe(HttpClientRequest.bodyUnsafeJson(body)),
    );
  });

describe("Durable Stream Server", () => {
  test(
    "POST returns 204",
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.post("/agents/test/stream").pipe(
          HttpClientRequest.bodyUnsafeJson({ type: "test", msg: "hello" }),
        ),
      );
      expect(response.status).toBe(204);
    }),
  );

  test(
    "SSE subscriber receives posted event",
    Effect.gen(function* () {
      const fiber = yield* subscribe("/agents/chat/room1");
      yield* Effect.sleep("50 millis");
      yield* post("/agents/chat/room1", { type: "message", text: "Hello SSE!" });

      const chunks = yield* Fiber.join(fiber);
      const data = Chunk.toReadonlyArray(chunks).join("");
      expect(data).toContain("data:");
      expect(data).toContain("Hello SSE!");
    }),
  );

  test(
    "multiple subscribers on same path receive same event",
    Effect.gen(function* () {
      const sub1 = yield* subscribe("/agents/broadcast/chan");
      const sub2 = yield* subscribe("/agents/broadcast/chan");
      yield* Effect.sleep("50 millis");
      yield* post("/agents/broadcast/chan", { msg: "broadcast" });

      const [chunks1, chunks2] = yield* Effect.all([Fiber.join(sub1), Fiber.join(sub2)]);
      expect(Chunk.toReadonlyArray(chunks1).join("")).toContain("broadcast");
      expect(Chunk.toReadonlyArray(chunks2).join("")).toContain("broadcast");
    }),
  );

  test(
    "different paths are independent",
    Effect.gen(function* () {
      const subA = yield* subscribe("/agents/path/a");
      const subB = yield* subscribe("/agents/path/b");
      yield* Effect.sleep("50 millis");
      yield* post("/agents/path/a", { source: "A" });

      const dataA = Chunk.toReadonlyArray(yield* Fiber.join(subA)).join("");
      expect(dataA).toContain("source");
      expect(dataA).toContain("A");

      const resultB = yield* Fiber.join(subB).pipe(
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
