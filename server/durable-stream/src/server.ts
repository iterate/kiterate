import { createServer } from "node:http";

import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
  HttpMiddleware,
} from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer, Schema, Stream } from "effect";

import { DurableStreamManager, StreamPath, Payload } from "./DurableStreamManager.js";
import * as Sse from "./Sse.js";

// GET /agents/* -> SSE stream
const subscribeHandler = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const rawPath = req.url.replace(/^\/agents\//, "").split("?")[0];
  const path = StreamPath.make(rawPath);
  const manager = yield* DurableStreamManager;

  const stream = manager.subscribe({ path, live: true }).pipe(Stream.map(Sse.data));

  return Sse.response(stream);
});

// POST /agents/* -> append event
const appendHandler = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const rawPath = req.url.replace(/^\/agents\//, "");
  const path = StreamPath.make(rawPath);
  const body = yield* req.json;
  const payload = yield* Schema.decodeUnknown(Payload)(body);

  const manager = yield* DurableStreamManager;
  yield* manager.append({ path, payload });

  return HttpServerResponse.empty({ status: 204 });
}).pipe(
  Effect.catchTag("ParseError", (error) =>
    HttpServerResponse.json({ error: error.message }, { status: 400 }),
  ),
);

// Router + serve layer (without Node HTTP - for testing)
export const AppLive = HttpRouter.empty.pipe(
  HttpRouter.get("/agents/*", subscribeHandler),
  HttpRouter.post("/agents/*", appendHandler),
  HttpServer.serve(HttpMiddleware.logger),
  HttpServer.withLogAddress,
);

// Full server layer (with Node HTTP - for production)
export const ServerLive = (port: number) =>
  AppLive.pipe(Layer.provide(NodeHttpServer.layer(createServer, { port })));
