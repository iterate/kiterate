/**
 * VoiceManager - Orchestrates voice interactions
 *
 * Connects VoiceConnection (device communication) with VoicePipeline (voice processing)
 * to handle complete voice assistant interactions.
 */

import { Effect, Context, Layer, Stream, Fiber, Ref, PubSub, Queue, Data, Schema, Chunk } from "effect";
import {
  VoiceConnectionService,
  VoiceConnectionError,
  type VoiceRequest,
  type VoiceAssistantEventType,
} from "./VoiceConnection.js";
import {
  VoicePipelineService,
  VoicePipelineError,
} from "./VoicePipeline.js";
import type { TranscriptionResult, IntentResult } from "./VoicePipeline.js";

// -------------------------------------------------------------------------------------
// Data types
// -------------------------------------------------------------------------------------

export class VoiceManagerError extends Data.TaggedError("VoiceManagerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const VoiceSessionState = Schema.Literal(
  "idle",
  "listening",
  "processing",
  "speaking",
  "error"
);
export type VoiceSessionState = typeof VoiceSessionState.Type;

export interface VoiceSession {
  readonly conversationId: string;
  readonly state: VoiceSessionState;
  readonly startedAt: Date;
  readonly transcription?: TranscriptionResult;
  readonly intent?: IntentResult;
  readonly error?: string;
}

export interface VoiceEvent {
  readonly type: "session_started" | "session_ended" | "state_changed" | "transcription" | "intent" | "error";
  readonly conversationId: string;
  readonly timestamp: Date;
  readonly data?: unknown;
}

// -------------------------------------------------------------------------------------
// VoiceManager service interface
// -------------------------------------------------------------------------------------

export interface VoiceManager {
  /** Start listening for voice interactions */
  readonly start: () => Effect.Effect<void, VoiceManagerError>;

  /** Stop listening for voice interactions */
  readonly stop: () => Effect.Effect<void>;

  /** Get current session state */
  readonly getCurrentSession: () => Effect.Effect<VoiceSession | undefined>;

  /** Subscribe to voice events */
  readonly events: Stream.Stream<VoiceEvent>;

  /** Send an announcement to the device */
  readonly announce: (text: string) => Effect.Effect<void, VoiceManagerError>;
}

export class VoiceManagerService extends Context.Tag("@voice-pe/VoiceManager")<
  VoiceManagerService,
  VoiceManager
>() {}

// -------------------------------------------------------------------------------------
// VoiceManager implementation
// -------------------------------------------------------------------------------------

export const VoiceManagerLive: Layer.Layer<
  VoiceManagerService,
  never,
  VoiceConnectionService | VoicePipelineService
> = Layer.effect(
  VoiceManagerService,
  Effect.gen(function* () {
    const connection = yield* VoiceConnectionService;
    const pipeline = yield* VoicePipelineService;

    const eventPubSub = yield* PubSub.unbounded<VoiceEvent>();
    const currentSessionRef = yield* Ref.make<VoiceSession | undefined>(undefined);
    const runningFiberRef = yield* Ref.make<Fiber.Fiber<void, VoiceManagerError | VoiceConnectionError | VoicePipelineError> | undefined>(undefined);

    const publishEvent = (event: VoiceEvent) =>
      PubSub.publish(eventPubSub, event).pipe(Effect.asVoid);

    const updateSession = (update: Partial<VoiceSession> | undefined) =>
      Ref.update(currentSessionRef, (current) => {
        if (update === undefined) return undefined;
        if (!current) return undefined;
        return { ...current, ...update };
      });

    const sendDeviceEvent = (event: VoiceAssistantEventType, data?: Array<{ name: string; value: string }>) =>
      connection.sendEvent(event, data).pipe(
        Effect.catchAll((error) => {
          console.error(`Failed to send device event ${event}:`, error);
          return Effect.void;
        })
      );

    const handleVoiceRequest = (request: VoiceRequest): Effect.Effect<void, VoiceConnectionError | VoicePipelineError> =>
      Effect.gen(function* () {
        if (!request.start) {
          // Stop request - end current session
          const session = yield* Ref.get(currentSessionRef);
          if (session) {
            yield* sendDeviceEvent("run_end");
            yield* publishEvent({
              type: "session_ended",
              conversationId: session.conversationId,
              timestamp: new Date(),
            });
            yield* Ref.set(currentSessionRef, undefined);
          }
          return;
        }

        // Start a new voice session
        const session: VoiceSession = {
          conversationId: request.conversationId,
          state: "listening",
          startedAt: new Date(),
        };
        yield* Ref.set(currentSessionRef, session);

        yield* publishEvent({
          type: "session_started",
          conversationId: request.conversationId,
          timestamp: new Date(),
          data: { wakeWordPhrase: request.wakeWordPhrase },
        });

        // Acknowledge the voice request (port 0 for API audio mode)
        yield* connection.sendResponse(0, false);

        // Send run start event
        yield* sendDeviceEvent("run_start");
        yield* sendDeviceEvent("stt_start");

        // Collect audio until we get an end marker
        const audioQueue = yield* Queue.unbounded<Buffer>();

        // Use runtime to properly run effects in the stream callback
        const collectAudio = connection.audioInput.pipe(
          Stream.tap((chunk) => Queue.offer(audioQueue, chunk.data)),
          Stream.takeWhile((chunk) => !chunk.end),
          Stream.runDrain
        );

        // Fork audio collection
        const audioFiber = yield* Effect.fork(collectAudio);

        // Wait for audio collection to complete
        yield* Fiber.join(audioFiber);

        // Signal end of audio collection
        yield* sendDeviceEvent("stt_vad_end");

        // Convert queue to stream for processing
        yield* updateSession({ state: "processing" });
        yield* publishEvent({
          type: "state_changed",
          conversationId: request.conversationId,
          timestamp: new Date(),
          data: { state: "processing" },
        });

        // Get all collected audio
        const audioChunks = yield* Queue.takeAll(audioQueue);
        const audioBuffer = Buffer.concat(Chunk.toReadonlyArray(audioChunks));
        const audioStream = Stream.make(audioBuffer);

        // Process through the voice pipeline
        const result = yield* pipeline.processVoiceRequest(
          audioStream,
          request.conversationId
        );

        // Send STT end event with transcription
        yield* sendDeviceEvent("stt_end", [
          { name: "text", value: result.transcription.text },
        ]);

        yield* updateSession({
          transcription: result.transcription,
        });
        yield* publishEvent({
          type: "transcription",
          conversationId: request.conversationId,
          timestamp: new Date(),
          data: result.transcription,
        });

        // Send intent events
        yield* sendDeviceEvent("intent_start");
        yield* sendDeviceEvent("intent_end", [
          { name: "intent", value: result.intent.intent },
        ]);

        yield* updateSession({
          intent: result.intent,
        });
        yield* publishEvent({
          type: "intent",
          conversationId: request.conversationId,
          timestamp: new Date(),
          data: result.intent,
        });

        // TTS response
        yield* updateSession({ state: "speaking" });
        yield* publishEvent({
          type: "state_changed",
          conversationId: request.conversationId,
          timestamp: new Date(),
          data: { state: "speaking" },
        });

        yield* sendDeviceEvent("tts_start", [
          { name: "text", value: result.intent.responseText },
        ]);
        yield* sendDeviceEvent("tts_stream_start");

        // Stream TTS audio to device
        yield* result.responseAudio.pipe(
          Stream.runForEach((chunk) =>
            connection.sendAudio({ data: chunk, end: false })
          )
        );

        // Signal end of TTS
        yield* connection.sendAudio({ data: Buffer.alloc(0), end: true });
        yield* sendDeviceEvent("tts_stream_end");
        yield* sendDeviceEvent("tts_end");

        // End the run
        yield* sendDeviceEvent("run_end");
        yield* updateSession({ state: "idle" });

        yield* publishEvent({
          type: "session_ended",
          conversationId: request.conversationId,
          timestamp: new Date(),
          data: {
            transcription: result.transcription,
            intent: result.intent,
          },
        });

        yield* Ref.set(currentSessionRef, undefined);
      });

    const start: VoiceManager["start"] = () =>
      Effect.gen(function* () {
        const existingFiber = yield* Ref.get(runningFiberRef);
        if (existingFiber) {
          return;
        }

        const fiber = yield* connection.voiceRequests.pipe(
          Stream.runForEach((request) =>
            handleVoiceRequest(request).pipe(
              Effect.catchAll((error) =>
                Effect.gen(function* () {
                  console.error("Error handling voice request:", error);
                  const currentSession = yield* Ref.get(currentSessionRef);
                  if (currentSession) {
                    yield* sendDeviceEvent("error", [
                      { name: "code", value: "processing_error" },
                      { name: "message", value: String(error) },
                    ]);
                    yield* sendDeviceEvent("run_end");
                    yield* updateSession({ state: "error", error: String(error) });
                    yield* publishEvent({
                      type: "error",
                      conversationId: currentSession.conversationId,
                      timestamp: new Date(),
                      data: { error: String(error) },
                    });
                    yield* Ref.set(currentSessionRef, undefined);
                  }
                })
              )
            )
          ),
          Effect.mapError((e) => new VoiceManagerError({
            message: "Voice request stream failed",
            cause: e,
          })),
          Effect.fork
        );

        yield* Ref.set(runningFiberRef, fiber);
      });

    const stop: VoiceManager["stop"] = () =>
      Effect.gen(function* () {
        const fiber = yield* Ref.get(runningFiberRef);
        if (fiber) {
          yield* Fiber.interrupt(fiber);
          yield* Ref.set(runningFiberRef, undefined);
        }
      });

    const getCurrentSession: VoiceManager["getCurrentSession"] = () =>
      Ref.get(currentSessionRef);

    const events: VoiceManager["events"] = Stream.unwrapScoped(
      Effect.map(PubSub.subscribe(eventPubSub), (queue) =>
        Stream.fromQueue(queue)
      )
    );

    const announce: VoiceManager["announce"] = (_text) =>
      new VoiceManagerError({
        message: "Announce not yet implemented",
      });

    return {
      start,
      stop,
      getCurrentSession,
      events,
      announce,
    };
  })
);
