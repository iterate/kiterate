/**
 * Grok Voice Client - WebSocket-based voice interaction with xAI
 *
 * Simplified client that returns raw event streams from Grok.
 */
import { Deferred, Effect, Layer, PubSub, Schema, Stream } from "effect";
import WebSocket from "ws";

// -------------------------------------------------------------------------------------
// Config
// -------------------------------------------------------------------------------------

export const VoiceName = Schema.Literal("ara", "rex", "sal", "eve", "leo");
export type VoiceName = typeof VoiceName.Type;

export const VoiceSessionConfig = Schema.Struct({
  apiKey: Schema.String,
  apiUrl: Schema.optional(Schema.String),
  voice: Schema.optional(VoiceName),
  sampleRate: Schema.optional(Schema.Number),
  instructions: Schema.optional(Schema.String),
});
export type VoiceSessionConfig = typeof VoiceSessionConfig.Type;

export const DEFAULT_API_URL = "wss://api.x.ai/v1/realtime";
export const DEFAULT_SAMPLE_RATE = 48000;
export const DEFAULT_VOICE: VoiceName = "ara";
export const DEFAULT_INSTRUCTIONS =
  "You are a helpful voice assistant. Keep your responses conversational and concise since they will be spoken aloud.";

// -------------------------------------------------------------------------------------
// Connection interface
// -------------------------------------------------------------------------------------

export interface GrokVoiceConnection {
  /** Send audio buffer to Grok */
  readonly send: (audio: Buffer) => Effect.Effect<void>;
  /** Send text prompt and trigger response */
  readonly sendText: (text: string) => Effect.Effect<void>;
  /** Stream of all raw events from Grok */
  readonly events: Stream.Stream<unknown>;
  /** Close the connection */
  readonly close: Effect.Effect<void>;
  /** Wait for session to be ready */
  readonly waitForReady: Effect.Effect<void>;
}

// -------------------------------------------------------------------------------------
// Service
// -------------------------------------------------------------------------------------

export class GrokVoiceClient extends Effect.Service<GrokVoiceClient>()("@grok/GrokVoiceClient", {
  effect: Effect.succeed({
    connect: (config: VoiceSessionConfig): Effect.Effect<GrokVoiceConnection, Error> =>
      Effect.gen(function* () {
        const apiUrl = config.apiUrl ?? DEFAULT_API_URL;
        const voice = config.voice ?? DEFAULT_VOICE;
        const instructions = config.instructions ?? DEFAULT_INSTRUCTIONS;
        const sampleRate = config.sampleRate ?? DEFAULT_SAMPLE_RATE;

        // PubSub for broadcasting events to all subscribers
        const eventPubSub = yield* PubSub.unbounded<unknown>();
        const readyDeferred = yield* Deferred.make<void>();

        let ws: WebSocket | null = null;
        let isConfigured = false;

        const sendSessionConfig = (socket: WebSocket) => {
          const sessionConfig = {
            type: "session.update",
            session: {
              instructions,
              voice,
              audio: {
                input: { format: { type: "audio/pcm", rate: sampleRate } },
                output: { format: { type: "audio/pcm", rate: sampleRate } },
              },
              input_audio_transcription: { model: "whisper-large-v3-turbo" },
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
                create_response: true,
              },
            },
          };
          socket.send(JSON.stringify(sessionConfig));
          isConfigured = true;
        };

        // Connect WebSocket
        yield* Effect.async<void, Error>((resume) => {
          const socket = new WebSocket(apiUrl, {
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              "Content-Type": "application/json",
            },
          });
          ws = socket;

          socket.on("open", () => resume(Effect.void));

          socket.on("message", (data) => {
            try {
              const message = JSON.parse(data.toString());
              Effect.runSync(PubSub.publish(eventPubSub, message));

              // Handle session setup
              if (message.type === "conversation.created" && !isConfigured) {
                sendSessionConfig(socket);
              } else if (message.type === "session.updated") {
                Effect.runSync(Deferred.succeed(readyDeferred, void 0));
              }
            } catch (e) {
              // Ignore parse errors
            }
          });

          socket.on("error", (error) => resume(Effect.fail(error as Error)));

          socket.on("close", () => {
            Effect.runSync(PubSub.shutdown(eventPubSub));
          });

          return Effect.sync(() => socket.close());
        });

        const send = (audio: Buffer): Effect.Effect<void> =>
          Effect.sync(() => {
            if (ws?.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "input_audio_buffer.append",
                  audio: audio.toString("base64"),
                }),
              );
            }
          });

        const sendText = (text: string): Effect.Effect<void> =>
          Effect.sync(() => {
            if (ws?.readyState === WebSocket.OPEN) {
              // Create conversation item
              ws.send(
                JSON.stringify({
                  type: "conversation.item.create",
                  item: {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text }],
                  },
                }),
              );
              // Trigger response
              ws.send(JSON.stringify({ type: "response.create" }));
            }
          });

        const close = Effect.sync(() => {
          ws?.close();
          ws = null;
        });

        const waitForReady = Deferred.await(readyDeferred);

        const events = Stream.fromPubSub(eventPubSub);

        return { send, sendText, events, close, waitForReady };
      }),
  }),
}) {}

export const GrokVoiceClientLive: Layer.Layer<GrokVoiceClient> = GrokVoiceClient.Default;
