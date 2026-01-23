import { createServer } from "node:http";

import {
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer, Schema, Stream } from "effect";

import { EventInput, Offset, StreamPath } from "./domain.js";
import * as StreamManager from "./services/stream-manager/index.js";
import * as Sse from "./sse.js";

// GET /agents/* -> SSE stream
const subscribeHandler = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const url = new URL(req.url, "http://localhost");
  const rawPath = url.pathname.replace(/^\/agents\//, "");
  const path = StreamPath.make(rawPath);

  // Parse query params
  const offsetParam = url.searchParams.get("offset");
  const liveParam = url.searchParams.get("live");

  const from = offsetParam ? Offset.make(offsetParam) : undefined;
  const live = liveParam === "sse" || liveParam === "true";

  const manager = yield* StreamManager.StreamManager;
  const stream = live
    ? manager.subscribe({ path, ...(from && { from }) })
    : manager.read({ path, ...(from && { from }) });

  return Sse.response(stream.pipe(Stream.map(Sse.data)));
});

// POST /agents/* -> append event
const appendHandler = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const rawPath = req.url.replace(/^\/agents\//, "");
  const path = StreamPath.make(rawPath);
  const body = yield* req.json;
  const event = yield* Schema.decodeUnknown(EventInput)(body);

  const manager = yield* StreamManager.StreamManager;
  yield* manager.append({ path, event });

  return HttpServerResponse.empty({ status: 204 });
}).pipe(
  Effect.withSpan("http.append-event"),
  Effect.tapError((error) => Effect.logError("Request failed", error)),
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
