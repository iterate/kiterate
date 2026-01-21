/**
 * Grok Voice Client - WebSocket-based voice interaction with xAI
 *
 * Simplified client that returns raw event streams from Grok.
 */
import { Config, Context, Deferred, Effect, Exit, Layer, Mailbox, Schema, Stream } from "effect";
import WebSocket from "ws";

// -------------------------------------------------------------------------------------
// Config
// -------------------------------------------------------------------------------------

export const VoiceName = Schema.Literal("ara", "rex", "sal", "eve", "leo");
export type VoiceName = typeof VoiceName.Type;

export const DEFAULT_API_URL = "wss://api.x.ai/v1/realtime";
export const DEFAULT_SAMPLE_RATE = 48000;
export const DEFAULT_VOICE: VoiceName = "ara";
export const DEFAULT_INSTRUCTIONS =
  "You are a helpful voice assistant. Keep your responses conversational and concise since they will be spoken aloud.";

export class GrokVoiceConnectionError extends Schema.TaggedError<GrokVoiceConnectionError>()(
  "GrokVoiceConnectionError",
  {
    message: Schema.String,
    error: Schema.Defect,
  },
) {}

export class GrokVoiceConfig extends Context.Tag("@grok/GrokVoiceConfig")<
  GrokVoiceConfig,
  {
    readonly apiKey: string;
    readonly apiUrl?: string;
    readonly voice?: VoiceName;
    readonly sampleRate?: number;
    readonly instructions?: string;
  }
>() {
  static defaultLayer = Layer.effect(
    GrokVoiceConfig,
    Effect.gen(function* () {
      const apiKey = yield* Config.string("XAI_API_KEY");
      return { apiKey };
    }),
  );
}

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
  effect: Effect.gen(function* () {
    const config = yield* GrokVoiceConfig;

    const connect = (): Effect.Effect<GrokVoiceConnection, GrokVoiceConnectionError> =>
      Effect.gen(function* () {
        const apiUrl = config.apiUrl ?? DEFAULT_API_URL;
        const voice = config.voice ?? DEFAULT_VOICE;
        const instructions = config.instructions ?? DEFAULT_INSTRUCTIONS;
        const sampleRate = config.sampleRate ?? DEFAULT_SAMPLE_RATE;

        // Mailbox for broadcasting events to subscribers
        const eventMailbox = yield* Mailbox.make<unknown>();
        const readyDeferred = yield* Deferred.make<void>();

        let ws: WebSocket | null = null;
        let isConfigured = false;

        /** Log a message being sent to Grok, redacting audio blobs */
        const logSend = (msg: unknown) => {
          const redacted = JSON.parse(
            JSON.stringify(msg, (key, value) => {
              if (key === "audio" && typeof value === "string" && value.length > 100) {
                return "<SOUND_BLOB>";
              }
              return value;
            }),
          );
          console.log("[grok-ws] ->", JSON.stringify(redacted));
        };

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
          logSend(sessionConfig);
          socket.send(JSON.stringify(sessionConfig));
          isConfigured = true;
        };

        // Connect WebSocket
        yield* Effect.async<void, GrokVoiceConnectionError>((resume) => {
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
              eventMailbox.unsafeOffer(message);

              // Handle session setup
              if (message.type === "conversation.created" && !isConfigured) {
                sendSessionConfig(socket);
              } else if (message.type === "session.updated") {
                Deferred.unsafeDone(readyDeferred, Effect.void);
              }
            } catch (e) {
              console.warn(
                "[grok-ws] Failed to parse message:",
                e,
                "raw:",
                data.toString().slice(0, 200),
              );
            }
          });

          socket.on("error", (error) =>
            resume(
              GrokVoiceConnectionError.make({
                message: error instanceof Error ? error.message : "WebSocket error",
                error,
              }),
            ),
          );

          socket.on("close", () => {
            eventMailbox.unsafeDone(Exit.void);
          });

          return Effect.sync(() => socket.close());
        });

        const send = (audio: Buffer): Effect.Effect<void> =>
          Effect.sync(() => {
            if (ws?.readyState === WebSocket.OPEN) {
              // Append audio to buffer
              const appendMsg = {
                type: "input_audio_buffer.append",
                audio: audio.toString("base64"),
              };
              logSend(appendMsg);
              ws.send(JSON.stringify(appendMsg));

              // Commit the buffer (for push-to-talk / recorded audio)
              const commitMsg = { type: "input_audio_buffer.commit" };
              logSend(commitMsg);
              ws.send(JSON.stringify(commitMsg));

              // Trigger response
              const responseMsg = { type: "response.create" };
              logSend(responseMsg);
              ws.send(JSON.stringify(responseMsg));
            }
          });

        const sendText = (text: string): Effect.Effect<void> =>
          Effect.sync(() => {
            if (ws?.readyState === WebSocket.OPEN) {
              // Create conversation item
              const createMsg = {
                type: "conversation.item.create",
                item: {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text }],
                },
              };
              logSend(createMsg);
              ws.send(JSON.stringify(createMsg));
              // Trigger response
              const responseMsg = { type: "response.create" };
              logSend(responseMsg);
              ws.send(JSON.stringify(responseMsg));
            }
          });

        const close = Effect.sync(() => {
          ws?.close();
          ws = null;
        });

        const waitForReady = Deferred.await(readyDeferred);

        const events = Mailbox.toStream(eventMailbox);

        return { send, sendText, events, close, waitForReady };
      });

    return { connect };
  }),
}) {}

export const GrokVoiceClientLive: Layer.Layer<GrokVoiceClient, never, GrokVoiceConfig> =
  GrokVoiceClient.Default;
