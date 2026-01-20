import { HttpClient, HttpClientRequest } from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Chunk, Effect, Layer, Stream } from "effect";

import { AppLive } from "./server.js";
import { liveLayer as streamManagerLiveLayer } from "./services/stream-manager/live.js";
import * as StreamStorage from "./services/stream-storage/index.js";

const testLayer = Layer.merge(
  AppLive.pipe(
    Layer.provide(streamManagerLiveLayer),
    Layer.provide(StreamStorage.inMemoryLayer),
    Layer.provide(NodeHttpServer.layerTest),
  ),
  NodeHttpServer.layerTest,
);

const test = <A, E>(name: string, effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
  it.scopedLive(name, () =>
    //
    effect.pipe(Effect.timeout("500 millis"), Effect.provide(testLayer)),
  );

// Raw HTTP SSE requires fork pattern - Stream.toQueue doesn't work with raw HTTP streams
const subscribe = (path: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(HttpClientRequest.get(path));
    return yield* response.stream.pipe(Stream.decodeText(), Stream.take(1), Stream.runCollect);
  }).pipe(Effect.fork);

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
      yield* Effect.sleep("10 millis");
      yield* post("/agents/chat/room1", { type: "message", text: "Hello SSE!" });

      const chunks = yield* fiber;
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
      yield* Effect.sleep("10 millis");
      yield* post("/agents/broadcast/chan", { msg: "broadcast" });

      const chunks1 = yield* sub1;
      const chunks2 = yield* sub2;
      expect(Chunk.toReadonlyArray(chunks1).join("")).toContain("broadcast");
      expect(Chunk.toReadonlyArray(chunks2).join("")).toContain("broadcast");
    }),
  );

  test(
    "different paths are independent",
    Effect.gen(function* () {
      const subA = yield* subscribe("/agents/path/a");
      const subB = yield* subscribe("/agents/path/b");
      yield* Effect.sleep("10 millis");
      yield* post("/agents/path/a", { source: "A" });

      const dataA = Chunk.toReadonlyArray(yield* subA).join("");
      expect(dataA).toContain("source");
      expect(dataA).toContain("A");

      const resultB = yield* subB.pipe(
        Effect.timeoutTo({
          duration: "50 millis",
          onSuccess: () => "received",
          onTimeout: () => "timeout",
        }),
      );
      expect(resultB).toBe("timeout");
    }),
  );

  test(
    "POST with invalid body returns 400",
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      const request = HttpClientRequest.post("/agents/test/invalid").pipe(
        HttpClientRequest.bodyUnsafeJson("not an object"),
      );
      const error = yield* client.execute(request).pipe(Effect.flip);
      expect(error._tag).toBe("ResponseError");
      expect((error as { response: { status: number } }).response.status).toBe(400);
    }),
  );
});
