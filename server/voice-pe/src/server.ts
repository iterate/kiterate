/**
 * HTTP Server for Voice PE
 *
 * Provides REST API and SSE streaming for voice manager control and events.
 */

import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
  HttpMiddleware,
} from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer, Stream, Schema } from "effect";
import { createServer } from "node:http";
import { VoiceManagerService } from "./VoiceManager.js";
import { VoiceConnectionService } from "./VoiceConnection.js";

// -------------------------------------------------------------------------------------
// Handlers
// -------------------------------------------------------------------------------------

// GET /health -> Health check
const healthHandler = HttpServerResponse.json({ status: "ok", service: "voice-pe" });

// GET /status -> Get current voice session status
const statusHandler = Effect.gen(function* () {
  const manager = yield* VoiceManagerService;
  const session = yield* manager.getCurrentSession();
  const connection = yield* VoiceConnectionService;
  const deviceInfo = yield* connection.deviceInfo.pipe(
    Effect.catchAll(() => Effect.succeed(undefined))
  );

  return yield* HttpServerResponse.json({
    device: deviceInfo,
    session: session ?? null,
  });
});

// POST /start -> Start voice manager
const startHandler = Effect.gen(function* () {
  const manager = yield* VoiceManagerService;
  yield* manager.start();
  return yield* HttpServerResponse.json({ status: "started" });
}).pipe(
  Effect.catchAll((error) =>
    HttpServerResponse.json(
      { error: String(error) },
      { status: 500 }
    )
  )
);

// POST /stop -> Stop voice manager
const stopHandler = Effect.gen(function* () {
  const manager = yield* VoiceManagerService;
  yield* manager.stop();
  return yield* HttpServerResponse.json({ status: "stopped" });
});

// POST /announce -> Send announcement to device
const AnnounceBody = Schema.Struct({
  text: Schema.String,
});

const announceHandler = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const body = yield* req.json;
  const parsed = yield* Schema.decodeUnknown(AnnounceBody)(body).pipe(
    Effect.mapError((e) => ({ _tag: "ParseError" as const, error: e }))
  );
  const manager = yield* VoiceManagerService;
  yield* manager.announce(parsed.text);
  return yield* HttpServerResponse.json({ status: "announced" });
}).pipe(
  Effect.catchAll((error) =>
    HttpServerResponse.json(
      { error: String(error) },
      { status: 500 }
    )
  )
);

// GET /events -> SSE stream of voice events
const eventsHandler = Effect.gen(function* () {
  const manager = yield* VoiceManagerService;

  // Send initial control event
  const controlEvent = `event: control\ndata: {"connected":true}\n\n`;

  const sseStream = Stream.make(controlEvent).pipe(
    Stream.concat(
      manager.events.pipe(
        Stream.map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
        )
      )
    ),
    Stream.encodeText
  );

  return HttpServerResponse.stream(sseStream, {
    contentType: "text/event-stream",
    headers: {
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
});

// -------------------------------------------------------------------------------------
// Router
// -------------------------------------------------------------------------------------

export const AppLive = HttpRouter.empty.pipe(
  HttpRouter.get("/health", healthHandler),
  HttpRouter.get("/status", statusHandler),
  HttpRouter.post("/start", startHandler),
  HttpRouter.post("/stop", stopHandler),
  HttpRouter.post("/announce", announceHandler),
  HttpRouter.get("/events", eventsHandler),
  HttpServer.serve(HttpMiddleware.logger),
  HttpServer.withLogAddress
);

// -------------------------------------------------------------------------------------
// Server layer
// -------------------------------------------------------------------------------------

export const ServerLive = (port: number) =>
  AppLive.pipe(Layer.provide(NodeHttpServer.layer(createServer, { port })));
