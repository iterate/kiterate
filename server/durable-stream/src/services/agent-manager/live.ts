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
    if (event.payload["role"] === "user" && event.payload["generate"] !== false) {
      return Option.some(String(event.payload["content"] ?? ""));
    }
    return Option.none();
  };

  /** Append response events from the LLM stream */
  const appendLlmResponse = (path: StreamPath, prompt: string) => {
    const responseStream = languageModel.streamText({ prompt });
    return responseStream.pipe(
      Stream.runForEach((part) =>
        Effect.gen(function* () {
          // Handle streaming part types
          if (part.type === "text-delta") {
            yield* streamManager.append({
              path,
              event: EventInput.make({
                type: EventType.make("assistant.text"),
                payload: { role: "assistant", type: "text", content: part.delta },
              }),
            });
          } else if (part.type === "finish") {
            yield* streamManager.append({
              path,
              event: EventInput.make({
                type: EventType.make("assistant.finish"),
                payload: { role: "assistant", type: "finish", reason: part.reason },
              }),
            });
          }
          // Ignore other streaming part types (text-start, text-end, reasoning-*, etc.)
        }),
      ),
    );
  };

  // -------------------------------------------------------------------------------------
  // Service methods
  // -------------------------------------------------------------------------------------

  const subscribe = (input: { path: StreamPath; from?: Offset; live?: boolean }) =>
    streamManager.subscribe(input);

  const append = (input: { path: StreamPath; event: EventInput }) =>
    Effect.gen(function* () {
      yield* streamManager.append(input);

      const prompt = getGenerationPrompt(input.event);
      if (Option.isSome(prompt)) {
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
