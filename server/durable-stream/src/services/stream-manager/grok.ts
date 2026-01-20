/**
 * Grok agent layer for StreamManager - uses xAI voice API
 *
 * Wraps an underlying StreamManager to:
 * - Detect user messages and trigger Grok voice generation
 * - Append all raw Grok events to the stream
 */
import { Effect, Fiber, Layer, Option, Scope, Stream } from "effect";

import { EventInput, EventType, type Offset, type StreamPath } from "../../domain.js";
import { GrokVoiceClient, type GrokVoiceConnection } from "../grok-voice/index.js";
import { StreamManager } from "./service.js";

const make = Effect.gen(function* () {
  const inner = yield* StreamManager;
  const voiceClient = yield* GrokVoiceClient;
  const scope = yield* Scope.Scope;

  // Lazy connection - established on first use
  let connection: GrokVoiceConnection | null = null;
  // Track current response fiber to interrupt on new request
  let currentResponseFiber: Fiber.RuntimeFiber<void, unknown> | null = null;

  const getConnection = Effect.gen(function* () {
    if (connection) return connection;
    const conn = yield* voiceClient.connect();
    yield* conn.waitForReady;
    connection = conn;
    return conn;
  });

  /** Interrupt any in-flight response fiber */
  const interruptCurrentResponse = Effect.gen(function* () {
    if (currentResponseFiber) {
      yield* Fiber.interrupt(currentResponseFiber);
      currentResponseFiber = null;
    }
  });

  /** Returns the prompt if generation should be triggered */
  const getGenerationPrompt = (event: EventInput): Option.Option<string> => {
    if (event.type === "iterate:agent:action:send-user-message:called") {
      const content = event.payload["content"];
      if (typeof content === "string") {
        return Option.some(content);
      }
    }
    return Option.none();
  };

  /** Returns base64-encoded audio if this is an audio input event */
  const getAudioInput = (event: EventInput): Option.Option<Buffer> => {
    if (event.type === "iterate:agent:action:send-user-audio:called") {
      const audio = event.payload["audio"];
      if (typeof audio === "string") {
        return Option.some(Buffer.from(audio, "base64"));
      }
    }
    return Option.none();
  };

  /** Pipe Grok events to stream until response.done (inclusive) */
  const streamGrokEvents = (path: StreamPath, conn: GrokVoiceConnection) =>
    conn.events.pipe(
      // takeUntil INCLUDES the matching element, so response.done is appended
      Stream.takeUntil((evt) => (evt as { type?: string }).type === "response.done"),
      Stream.runForEach((evt) =>
        inner.append({
          path,
          event: EventInput.make({
            type: EventType.make("grok:event"),
            payload: evt as Record<string, unknown>,
          }),
        }),
      ),
    );

  /** Send text to Grok and stream all raw events back to the stream */
  const appendGrokResponse = (path: StreamPath, prompt: string) =>
    Effect.gen(function* () {
      const conn = yield* getConnection;
      yield* conn.sendText(prompt);
      yield* streamGrokEvents(path, conn);
    });

  /** Send audio to Grok and stream response events back to the stream */
  const appendGrokAudio = (path: StreamPath, audio: Buffer) =>
    Effect.gen(function* () {
      const conn = yield* getConnection;
      yield* conn.send(audio);
      yield* streamGrokEvents(path, conn);
    });

  const subscribe = (input: { path: StreamPath; after?: Offset; live?: boolean }) =>
    inner.subscribe(input);

  const append = (input: { path: StreamPath; event: EventInput }) =>
    Effect.gen(function* () {
      yield* Effect.log(`GrokAgent.append: type=${input.event.type}`);
      yield* inner.append(input);

      // Handle text prompts - fork to background so append returns immediately
      const prompt = getGenerationPrompt(input.event);
      if (Option.isSome(prompt)) {
        yield* Effect.log(`Triggering Grok text: ${prompt.value.slice(0, 50)}...`);
        // Interrupt previous response before starting new one
        yield* interruptCurrentResponse;
        currentResponseFiber = yield* appendGrokResponse(input.path, prompt.value).pipe(
          Effect.catchAll((error) => Effect.logError("Grok failed", error)),
          Effect.forkIn(scope),
        );
        return;
      }

      // Handle audio input - fork to background so append returns immediately
      const audioInput = getAudioInput(input.event);
      if (Option.isSome(audioInput)) {
        yield* Effect.log(`Triggering Grok audio: ${audioInput.value.length} bytes`);
        // Interrupt previous response before starting new one
        yield* interruptCurrentResponse;
        currentResponseFiber = yield* appendGrokAudio(input.path, audioInput.value).pipe(
          Effect.catchAll((error) => Effect.logError("Grok audio failed", error)),
          Effect.forkIn(scope),
        );
      }
    });

  return StreamManager.of({ subscribe, append });
});

export const grokLayer: Layer.Layer<StreamManager, never, StreamManager | GrokVoiceClient> =
  Layer.scoped(StreamManager, make);

// -------------------------------------------------------------------------------------
// Test layer
// -------------------------------------------------------------------------------------

const makeTest = Effect.gen(function* () {
  const inner = yield* StreamManager;

  const subscribe = (input: { path: StreamPath; after?: Offset; live?: boolean }) =>
    inner.subscribe(input);

  const append = (input: { path: StreamPath; event: EventInput }) =>
    Effect.gen(function* () {
      yield* Effect.log(`GrokAgent(test).append: type=${input.event.type} [Grok disabled]`);
      yield* inner.append(input);
    });

  return StreamManager.of({ subscribe, append });
});

export const grokTestLayer: Layer.Layer<StreamManager, never, StreamManager> = Layer.effect(
  StreamManager,
  makeTest,
);
