/**
 * AgentManager live layer - uses @effect/ai for LLM integration
 */
import { LanguageModel } from "@effect/ai";
import { Effect, Layer, Option, Stream } from "effect";

import { EventInput, EventType, type Offset, type StreamPath } from "../../domain.js";
import { StreamManager } from "../stream-manager/service.js";
import { AgentManager, AgentManagerError } from "./service.js";

const make = Effect.gen(function* () {
  const streamManager = yield* StreamManager;
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
        streamManager.append({
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
    streamManager.subscribe(input);

  const append = (input: { path: StreamPath; event: EventInput }) =>
    Effect.gen(function* () {
      yield* Effect.log(`AgentManager.append: type=${input.event.type}`);
      yield* streamManager.append(input);

      const prompt = getGenerationPrompt(input.event);
      if (Option.isSome(prompt)) {
        yield* Effect.log(`Triggering LLM generation for prompt: ${prompt.value.slice(0, 50)}...`);
        yield* appendLlmResponse(input.path, prompt.value);
      }
    }).pipe(Effect.mapError((cause) => AgentManagerError.make({ operation: "append", cause })));

  return AgentManager.of({ subscribe, append });
});

export const liveLayer: Layer.Layer<
  AgentManager,
  never,
  StreamManager | LanguageModel.LanguageModel
> = Layer.effect(AgentManager, make);

// -------------------------------------------------------------------------------------
// Test layer - no LLM, just delegates to StreamManager
// -------------------------------------------------------------------------------------

const makeTest = Effect.gen(function* () {
  const streamManager = yield* StreamManager;

  const subscribe = (input: { path: StreamPath; after?: Offset; live?: boolean }) =>
    streamManager.subscribe(input);

  const append = (input: { path: StreamPath; event: EventInput }) =>
    Effect.gen(function* () {
      yield* Effect.log(`AgentManager(test).append: type=${input.event.type} [LLM disabled]`);
      yield* streamManager.append(input);
    }).pipe(Effect.mapError((cause) => AgentManagerError.make({ operation: "append", cause })));

  return AgentManager.of({ subscribe, append });
});

/** Test layer - no LLM integration, just delegates to StreamManager */
export const testLayer: Layer.Layer<AgentManager, never, StreamManager> = Layer.effect(
  AgentManager,
  makeTest,
);
