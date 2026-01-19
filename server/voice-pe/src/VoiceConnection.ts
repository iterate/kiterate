/**
 * VoiceConnection - ESPHome Native API client wrapper
 *
 * Manages the connection to a Voice PE device using the esphome-client library.
 * Provides an Effect-based interface for voice assistant communication.
 */

import { Effect, Context, Layer, Stream, PubSub, Scope, Data, Schema, Runtime, Deferred } from "effect";
import {
  EspHomeClient,
  VoiceAssistantSubscribeFlag,
  VoiceAssistantEvent,
  type VoiceAssistantEventData,
  type DeviceInfo as EspHomeDeviceInfo,
} from "esphome-client";

// -------------------------------------------------------------------------------------
// Data types
// -------------------------------------------------------------------------------------

export const DeviceConfig = Schema.Struct({
  host: Schema.String,
  port: Schema.optionalWith(Schema.Number, { default: () => 6053 }),
  psk: Schema.optional(Schema.String),
  clientId: Schema.optionalWith(Schema.String, { default: () => "voice-pe-server" }),
});
export type DeviceConfig = typeof DeviceConfig.Type;

export class VoiceConnectionError extends Data.TaggedError("VoiceConnectionError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface VoiceRequest {
  readonly start: boolean;
  readonly conversationId: string;
  readonly flags: number;
  readonly wakeWordPhrase?: string | undefined;
}

export interface AudioChunk {
  readonly data: Buffer;
  readonly end: boolean;
}

export interface VoiceEventData {
  readonly name: string;
  readonly value: string;
}

// -------------------------------------------------------------------------------------
// VoiceConnection service interface
// -------------------------------------------------------------------------------------

export interface VoiceConnection {
  /** Subscribe to voice assistant requests from the device */
  readonly voiceRequests: Stream.Stream<VoiceRequest>;

  /** Subscribe to incoming audio chunks from the device */
  readonly audioInput: Stream.Stream<AudioChunk>;

  /** Send an audio chunk to the device for playback */
  readonly sendAudio: (chunk: AudioChunk) => Effect.Effect<void, VoiceConnectionError>;

  /** Send a voice event to the device (pipeline state changes) */
  readonly sendEvent: (
    event: VoiceAssistantEventType,
    data?: VoiceEventData[]
  ) => Effect.Effect<void, VoiceConnectionError>;

  /** Send a voice response (acknowledge a voice request) */
  readonly sendResponse: (
    port: number,
    error: boolean
  ) => Effect.Effect<void, VoiceConnectionError>;

  /** Disconnect from the device */
  readonly disconnect: () => Effect.Effect<void>;

  /** Get device info */
  readonly deviceInfo: Effect.Effect<DeviceInfo, VoiceConnectionError>;
}

export interface DeviceInfo {
  readonly name?: string | undefined;
  readonly macAddress?: string | undefined;
  readonly model?: string | undefined;
  readonly esphomeVersion?: string | undefined;
}

export type VoiceAssistantEventType =
  | "error"
  | "run_start"
  | "run_end"
  | "stt_start"
  | "stt_end"
  | "intent_start"
  | "intent_end"
  | "tts_start"
  | "tts_end"
  | "wake_word_start"
  | "wake_word_end"
  | "stt_vad_start"
  | "stt_vad_end"
  | "tts_stream_start"
  | "tts_stream_end"
  | "intent_progress";

const eventTypeToEnum: Record<VoiceAssistantEventType, VoiceAssistantEvent> = {
  error: VoiceAssistantEvent.ERROR,
  run_start: VoiceAssistantEvent.RUN_START,
  run_end: VoiceAssistantEvent.RUN_END,
  stt_start: VoiceAssistantEvent.STT_START,
  stt_end: VoiceAssistantEvent.STT_END,
  intent_start: VoiceAssistantEvent.INTENT_START,
  intent_end: VoiceAssistantEvent.INTENT_END,
  tts_start: VoiceAssistantEvent.TTS_START,
  tts_end: VoiceAssistantEvent.TTS_END,
  wake_word_start: VoiceAssistantEvent.WAKE_WORD_START,
  wake_word_end: VoiceAssistantEvent.WAKE_WORD_END,
  stt_vad_start: VoiceAssistantEvent.STT_VAD_START,
  stt_vad_end: VoiceAssistantEvent.STT_VAD_END,
  tts_stream_start: VoiceAssistantEvent.TTS_STREAM_START,
  tts_stream_end: VoiceAssistantEvent.TTS_STREAM_END,
  intent_progress: VoiceAssistantEvent.INTENT_PROGRESS,
};

// -------------------------------------------------------------------------------------
// VoiceConnection service tag
// -------------------------------------------------------------------------------------

export class VoiceConnectionService extends Context.Tag("@voice-pe/VoiceConnection")<
  VoiceConnectionService,
  VoiceConnection
>() {}

// -------------------------------------------------------------------------------------
// VoiceConnection implementation
// -------------------------------------------------------------------------------------

const makeVoiceConnection = (config: DeviceConfig): Effect.Effect<VoiceConnection, VoiceConnectionError, Scope.Scope> =>
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>();
    const voiceRequestPubSub = yield* PubSub.unbounded<VoiceRequest>();
    const audioInputPubSub = yield* PubSub.unbounded<AudioChunk>();

    // Create the ESPHome client
    const client = new EspHomeClient({
      host: config.host,
      port: config.port,
      psk: config.psk ?? null,
      clientId: config.clientId,
    });

    let deviceInfoCache: DeviceInfo | undefined;

    // Set up event handlers using runtime to properly run effects
    client.on("voiceAssistantRequest", (data: Record<string, unknown>) => {
      const wakeWordPhrase = data.wakeWordPhrase ? String(data.wakeWordPhrase) : undefined;
      const request: VoiceRequest = {
        start: Boolean(data.start),
        conversationId: String(data.conversationId ?? ""),
        flags: Number(data.flags ?? 0),
        ...(wakeWordPhrase !== undefined ? { wakeWordPhrase } : {}),
      };
      Runtime.runFork(runtime)(PubSub.publish(voiceRequestPubSub, request));
    });

    client.on("voiceAssistantAudio", (data: { chunk: Buffer }) => {
      const chunk: AudioChunk = {
        data: data.chunk,
        end: false,
      };
      Runtime.runFork(runtime)(PubSub.publish(audioInputPubSub, chunk));
    });

    client.on("deviceInfo", (info: EspHomeDeviceInfo) => {
      deviceInfoCache = {
        ...(info.name !== undefined ? { name: info.name } : {}),
        ...(info.macAddress !== undefined ? { macAddress: info.macAddress } : {}),
        ...(info.model !== undefined ? { model: info.model } : {}),
        ...(info.esphomeVersion !== undefined ? { esphomeVersion: info.esphomeVersion } : {}),
      };
    });

    // Connect to the device using event-based connection
    const connectDeferred = yield* Deferred.make<void, VoiceConnectionError>();

    client.on("connect", () => {
      Runtime.runFork(runtime)(Deferred.succeed(connectDeferred, undefined));
    });

    client.on("disconnect", (reason: string | undefined) => {
      // Only fail if we haven't connected yet (deferred is still pending)
      Runtime.runFork(runtime)(
        Deferred.fail(connectDeferred, new VoiceConnectionError({
          message: reason ? `Connection failed: ${reason}` : "Connection failed",
        }))
      );
    });

    // Start connection (non-blocking, event-driven)
    yield* Effect.try({
      try: () => client.connect(),
      catch: (error) => new VoiceConnectionError({
        message: `Failed to initiate connection to device at ${config.host}:${config.port}`,
        cause: error,
      }),
    });

    // Wait for connection with timeout
    yield* Deferred.await(connectDeferred).pipe(
      Effect.timeout("30 seconds"),
      Effect.catchTag("TimeoutException", () =>
        Effect.fail(new VoiceConnectionError({
          message: `Connection to device at ${config.host}:${config.port} timed out after 30 seconds`,
        }))
      )
    );

    // Subscribe to voice assistant events with API audio
    yield* Effect.try({
      try: () => client.subscribeVoiceAssistant(VoiceAssistantSubscribeFlag.API_AUDIO),
      catch: (error) => new VoiceConnectionError({
        message: "Failed to subscribe to voice assistant",
        cause: error,
      }),
    });

    // Register cleanup
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        client.disconnect();
      })
    );

    const voiceRequests = Stream.unwrapScoped(
      Effect.map(PubSub.subscribe(voiceRequestPubSub), (queue) =>
        Stream.fromQueue(queue)
      )
    );

    const audioInput = Stream.unwrapScoped(
      Effect.map(PubSub.subscribe(audioInputPubSub), (queue) =>
        Stream.fromQueue(queue)
      )
    );

    const sendAudio = (chunk: AudioChunk): Effect.Effect<void, VoiceConnectionError> =>
      Effect.try({
        try: () => client.sendVoiceAssistantAudio(chunk.data, chunk.end),
        catch: (error) => new VoiceConnectionError({
          message: "Failed to send audio to device",
          cause: error,
        }),
      });

    const sendEvent = (
      event: VoiceAssistantEventType,
      data?: VoiceEventData[]
    ): Effect.Effect<void, VoiceConnectionError> =>
      Effect.try({
        try: () => {
          const eventEnum = eventTypeToEnum[event];
          const eventData: VoiceAssistantEventData[] | undefined = data?.map((d) => ({
            name: d.name,
            value: d.value,
          }));
          client.sendVoiceAssistantEvent(eventEnum, eventData);
        },
        catch: (error) => new VoiceConnectionError({
          message: `Failed to send event ${event} to device`,
          cause: error,
        }),
      });

    const sendResponse = (port: number, error: boolean): Effect.Effect<void, VoiceConnectionError> =>
      Effect.try({
        try: () => client.sendVoiceAssistantResponse(port, error),
        catch: (err) => new VoiceConnectionError({
          message: "Failed to send voice response to device",
          cause: err,
        }),
      });

    const disconnect = (): Effect.Effect<void> =>
      Effect.sync(() => {
        client.disconnect();
      });

    const deviceInfo: Effect.Effect<DeviceInfo, VoiceConnectionError> = Effect.gen(function* () {
      if (deviceInfoCache) {
        return deviceInfoCache;
      }
      return yield* new VoiceConnectionError({
        message: "Device info not available yet",
      });
    });

    return {
      voiceRequests,
      audioInput,
      sendAudio,
      sendEvent,
      sendResponse,
      disconnect,
      deviceInfo,
    };
  });

// -------------------------------------------------------------------------------------
// VoiceConnection layer
// -------------------------------------------------------------------------------------

export const VoiceConnectionLive = (config: DeviceConfig): Layer.Layer<VoiceConnectionService, VoiceConnectionError> =>
  Layer.scoped(
    VoiceConnectionService,
    makeVoiceConnection(config)
  );
