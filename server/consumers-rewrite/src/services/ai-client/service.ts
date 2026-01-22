/**
 * AI Client Service
 *
 * Provides AI client abstraction for OpenAI and Grok models.
 */
import { LanguageModel } from "@effect/ai";
import { Context, Effect, Layer, Option, Schema, Stream } from "effect";

import { EventInput, EventType, type StreamPath } from "../../domain.js";
import { ConfigSetEvent, UserAudioEvent, UserMessageEvent } from "../../events.js";
import { GrokVoiceClient, type GrokVoiceConnection } from "../grok-voice/client.js";

// -------------------------------------------------------------------------------------
// Prompt Input Types
// -------------------------------------------------------------------------------------

export class TextPrompt extends Schema.TaggedClass<TextPrompt>()("TextPrompt", {
  content: Schema.String,
}) {}

export class AudioPrompt extends Schema.TaggedClass<AudioPrompt>()("AudioPrompt", {
  /** PCM audio data */
  data: Schema.Uint8ArrayFromSelf,
}) {}

export type PromptInput = TextPrompt | AudioPrompt;
export const PromptInput = Object.assign(Schema.Union(TextPrompt, AudioPrompt), {
  /** Extract a PromptInput from an EventInput, if applicable */
  fromEventInput: (event: EventInput): Option.Option<PromptInput> =>
    Option.orElse(
      Option.map(
        UserMessageEvent.decodeOption(event),
        (p) => new TextPrompt({ content: p.content }),
      ),
      () =>
        Option.map(UserAudioEvent.decodeOption(event), (p) => {
          const data = new Uint8Array(Buffer.from(p.audio, "base64"));
          return new AudioPrompt({ data });
        }),
    ),
});

// -------------------------------------------------------------------------------------
// AI Model Type
// -------------------------------------------------------------------------------------

export const AiModelType = Object.assign(Schema.Literal("openai", "grok"), {
  fromEventInput: (event: EventInput): Option.Option<AiModelType> =>
    Option.map(ConfigSetEvent.decodeOption(event), (p) => p.model),
});
export type AiModelType = typeof AiModelType.Type;

// -------------------------------------------------------------------------------------
// Client Constructors
// -------------------------------------------------------------------------------------

const makeOpenAiClient = Effect.gen(function* () {
  const languageModel = yield* LanguageModel.LanguageModel;

  return {
    prompt: (input: PromptInput): Stream.Stream<EventInput, never> => {
      if (input._tag === "AudioPrompt") {
        return Stream.make(
          EventInput.make({
            type: EventType.make("iterate:ai:error"),
            payload: {
              error: "unsupported_input",
              message: "OpenAI does not support audio input. Switch to Grok for voice.",
              model: "openai",
              inputType: "audio",
            },
          }),
        );
      }

      return languageModel.streamText({ prompt: input.content }).pipe(
        Stream.map((part) =>
          EventInput.make({
            type: EventType.make("iterate:openai:response:sse"),
            payload: { part },
          }),
        ),
        Stream.catchAll((error) =>
          Stream.fromEffect(Effect.logError("LLM generation failed", error)).pipe(
            Stream.as(
              EventInput.make({
                type: EventType.make("iterate:ai:error"),
                payload: {
                  error: "generation_failed",
                  message: `OpenAI generation failed: ${error instanceof Error ? error.message : String(error)}`,
                  model: "openai",
                },
              }),
            ),
          ),
        ),
      );
    },
  };
});

const makeGrokClient = Effect.gen(function* () {
  const grokVoiceClient = yield* GrokVoiceClient;

  // Per-path connection cache
  // TODO: Add connection lifecycle management:
  //   - Evict stale/failed connections
  //   - Health checks for long-lived connections
  //   - Reconnect on WebSocket close/error
  const connectionsByPath = new Map<StreamPath, GrokVoiceConnection>();

  const getConnection = (path: StreamPath) =>
    Effect.gen(function* () {
      const existing = connectionsByPath.get(path);
      if (existing) return existing;

      yield* Effect.log(`Creating Grok connection for path: ${path}`);
      const connection = yield* grokVoiceClient.connect();
      yield* connection.waitForReady;
      connectionsByPath.set(path, connection);
      return connection;
    });

  return {
    prompt: (path: StreamPath, input: PromptInput): Stream.Stream<EventInput, never> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const connection = yield* getConnection(path);

          if (input._tag === "AudioPrompt") {
            yield* connection.send(Buffer.from(input.data));
          } else {
            yield* connection.sendText(input.content);
          }

          return connection.events.pipe(
            Stream.map((event) => {
              // Validate event is an object, wrap primitives
              const payload: Record<string, unknown> =
                typeof event === "object" && event !== null && !Array.isArray(event)
                  ? (event as Record<string, unknown>)
                  : { value: event };
              return EventInput.make({
                type: EventType.make("iterate:grok:response:sse"),
                payload,
              });
            }),
          );
        }).pipe(
          Effect.catchAll((error) =>
            Effect.gen(function* () {
              yield* Effect.logError("Grok connection failed", error);
              return Stream.make(
                EventInput.make({
                  type: EventType.make("iterate:ai:error"),
                  payload: {
                    error: "connection_failed",
                    message: `Grok connection failed: ${error instanceof Error ? error.message : String(error)}`,
                    model: "grok",
                  },
                }),
              );
            }),
          ),
        ),
      ),
  };
});

// -------------------------------------------------------------------------------------
// AI Client Service
// -------------------------------------------------------------------------------------

export class AiClient extends Context.Tag("@app/AiClient")<
  AiClient,
  {
    readonly prompt: (
      model: AiModelType,
      path: StreamPath,
      input: PromptInput,
    ) => Stream.Stream<EventInput, never>;
  }
>() {
  static layer = Layer.effect(
    AiClient,
    Effect.gen(function* () {
      const openAi = yield* makeOpenAiClient;
      const grok = yield* makeGrokClient;

      const prompt = (
        model: AiModelType,
        path: StreamPath,
        input: PromptInput,
      ): Stream.Stream<EventInput, never> =>
        model === "openai" ? openAi.prompt(input) : grok.prompt(path, input);

      return { prompt };
    }),
  );
}
