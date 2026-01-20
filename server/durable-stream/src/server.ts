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

import * as Sse from "./Sse.js";
import { StreamManager, StreamPath, Event } from "./StreamManager.js";

// GET /agents/* -> SSE stream
const subscribeHandler = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const path = req.url.replace(/^\/agents\//, "").split("?")[0];
  const streamPath = StreamPath.make(path);
  const manager = yield* StreamManager;

  const stream = manager.subscribe({ streamPath }).pipe(Stream.map(Sse.data));

  return Sse.response(stream);
});

// POST /agents/* -> append event
const appendHandler = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const path = req.url.replace(/^\/agents\//, "");
  const streamPath = StreamPath.make(path);
  const body = yield* req.json;
  const event = yield* Schema.decodeUnknown(Event)(body);

  const manager = yield* StreamManager;
  yield* manager.append({ streamPath, event });

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
