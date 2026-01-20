/**
 * Agent layer for StreamManager - adds LLM integration
 *
 * Wraps an underlying StreamManager to:
 * - Detect user messages and trigger LLM generation
 * - Append LLM response events to the stream
 */
import { LanguageModel } from "@effect/ai";
import { Effect, Layer, Option, Stream } from "effect";

import { EventInput, EventType, type Offset, type StreamPath } from "../../domain.js";
import { StreamManager } from "./service.js";

const make = Effect.gen(function* () {
  const inner = yield* StreamManager;
  const languageModel = yield* LanguageModel.LanguageModel;

  // -------------------------------------------------------------------------------------
  // Helpers (closed over dependencies)
  // -------------------------------------------------------------------------------------

  /** Returns the prompt if generation should be triggered, None otherwise */
  const getGenerationPrompt = (event: EventInput): Option.Option<string> => {
    if (event.type === "iterate:agent:action:send-user-message:called") {
      const content = event.payload["content"];
      if (typeof content === "string") {
        return Option.some(content);
      }
    }
    return Option.none();
  };

  /** Append response events from the LLM stream */
  const appendLlmResponse = (path: StreamPath, prompt: string) => {
    const responseStream = languageModel.streamText({ prompt });
    return responseStream.pipe(
      Stream.runForEach((part) =>
        inner.append({
          path,
          event: EventInput.make({
            type: EventType.make("iterate:llm:response:sse"),
            payload: { ...part },
          }),
        }),
      ),
    );
  };

  // -------------------------------------------------------------------------------------
  // Service methods
  // -------------------------------------------------------------------------------------

  const subscribe = (input: { path: StreamPath; after?: Offset; live?: boolean }) =>
    inner.subscribe(input);

  const append = (input: { path: StreamPath; event: EventInput }) =>
    Effect.gen(function* () {
      yield* Effect.log(`AgentManager.append: type=${input.event.type}`);
      yield* inner.append(input);

      const prompt = getGenerationPrompt(input.event);
      if (Option.isSome(prompt)) {
        yield* Effect.log(`Triggering LLM generation for prompt: ${prompt.value.slice(0, 50)}...`);
        yield* appendLlmResponse(input.path, prompt.value).pipe(
          Effect.catchAll((error) => Effect.logError("LLM generation failed", error)),
        );
      }
    });

  return StreamManager.of({ subscribe, append });
});

export const agentLayer: Layer.Layer<
  StreamManager,
  never,
  StreamManager | LanguageModel.LanguageModel
> = Layer.effect(StreamManager, make);

// -------------------------------------------------------------------------------------
// Test layer - no LLM, just logs and delegates
// -------------------------------------------------------------------------------------

const makeTest = Effect.gen(function* () {
  const inner = yield* StreamManager;

  const subscribe = (input: { path: StreamPath; after?: Offset; live?: boolean }) =>
    inner.subscribe(input);

  const append = (input: { path: StreamPath; event: EventInput }) =>
    Effect.gen(function* () {
      yield* Effect.log(`AgentManager(test).append: type=${input.event.type} [LLM disabled]`);
      yield* inner.append(input);
    });

  return StreamManager.of({ subscribe, append });
});

/** Test layer - no LLM integration, just logs and delegates */
export const testLayer: Layer.Layer<StreamManager, never, StreamManager> = Layer.effect(
  StreamManager,
  makeTest,
);
