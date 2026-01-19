import { Effect, Stream, Chunk, Fiber, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpServer } from "@effect/platform";
import { NodeHttpClient, NodeHttpServer } from "@effect/platform-node";
import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { AppLive } from "./server.js";
import { InMemoryStreamManager } from "./StreamManager.js";

// Build test layers using the actual server
const HttpLive = NodeHttpServer.layer(createServer, { port: 0 });

const ServerLayer = AppLive.pipe(Layer.provide(InMemoryStreamManager));

const TestClient = HttpServer.layerTestClient.pipe(
  Layer.provide(NodeHttpClient.layer),
  Layer.provide(ServerLayer),
  Layer.provide(HttpLive),
);

describe("Durable Stream Server", () => {
  it("POST returns 204", async () => {
    const program = Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;

      const response = yield* client.execute(
        HttpClientRequest.post("/agents/test/stream").pipe(
          HttpClientRequest.bodyUnsafeJson({ type: "test", msg: "hello" }),
        ),
      );

      expect(response.status).toBe(204);
    });

    await Effect.runPromise(
      program.pipe(Effect.provide(TestClient), Effect.scoped),
    );
  });

  it("SSE subscriber receives posted event", async () => {
    const program = Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;

      const subscriberFiber = yield* Effect.gen(function* () {
        const response = yield* client.execute(
          HttpClientRequest.get("/agents/chat/room1"),
        );
        return yield* response.stream.pipe(
          Stream.decodeText(),
          Stream.take(2), // control event + data event
          Stream.runCollect,
        );
      }).pipe(Effect.fork);

      yield* Effect.sleep("50 millis");

      yield* client.execute(
        HttpClientRequest.post("/agents/chat/room1").pipe(
          HttpClientRequest.bodyUnsafeJson({
            type: "message",
            text: "Hello SSE!",
          }),
        ),
      );

      const chunks = yield* Fiber.join(subscriberFiber);
      const data = Chunk.toReadonlyArray(chunks).join("");

      expect(data).toContain("data:");
      expect(data).toContain("Hello SSE!");
    });

    await Effect.runPromise(
      program.pipe(Effect.provide(TestClient), Effect.scoped),
    );
  });

  it("multiple subscribers on same path receive same event", async () => {
    const program = Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;

      const makeSubscriber = (path: string) =>
        Effect.gen(function* () {
          const response = yield* client.execute(HttpClientRequest.get(path));
          return yield* response.stream.pipe(
            Stream.decodeText(),
            Stream.take(2), // control event + data event
            Stream.runCollect,
          );
        }).pipe(Effect.fork);

      const sub1 = yield* makeSubscriber("/agents/broadcast/chan");
      const sub2 = yield* makeSubscriber("/agents/broadcast/chan");

      yield* Effect.sleep("50 millis");

      yield* client.execute(
        HttpClientRequest.post("/agents/broadcast/chan").pipe(
          HttpClientRequest.bodyUnsafeJson({ msg: "broadcast" }),
        ),
      );

      const [chunks1, chunks2] = yield* Effect.all([
        Fiber.join(sub1),
        Fiber.join(sub2),
      ]);

      const data1 = Chunk.toReadonlyArray(chunks1).join("");
      const data2 = Chunk.toReadonlyArray(chunks2).join("");

      expect(data1).toContain("broadcast");
      expect(data2).toContain("broadcast");
    });

    await Effect.runPromise(
      program.pipe(Effect.provide(TestClient), Effect.scoped),
    );
  });

  it("different paths are independent", async () => {
    const program = Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;

      const subscribe = (path: string) =>
        Effect.gen(function* () {
          const response = yield* client.execute(HttpClientRequest.get(path));
          return yield* response.stream.pipe(
            Stream.decodeText(),
            Stream.take(2), // control event + data event
            Stream.runCollect,
          );
        }).pipe(Effect.fork);

      const subA = yield* subscribe("/agents/path/a");
      const subB = yield* subscribe("/agents/path/b");

      yield* Effect.sleep("50 millis");

      yield* client.execute(
        HttpClientRequest.post("/agents/path/a").pipe(
          HttpClientRequest.bodyUnsafeJson({ source: "A" }),
        ),
      );

      const chunksA = yield* Fiber.join(subA);
      const dataA = Chunk.toReadonlyArray(chunksA).join("");
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
    });

    await Effect.runPromise(
      program.pipe(Effect.provide(TestClient), Effect.scoped),
    );
  });
});
