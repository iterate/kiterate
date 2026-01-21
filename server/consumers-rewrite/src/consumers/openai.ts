/**
 * OpenAI Consumer
 *
 * Triggers OpenAI generation when:
 * - The path is configured for "openai" model
 * - A user prompt event is received
 */
import { Effect, Option, Stream } from "effect";

import { Consumer, toLayer } from "./consumer.js";
import { AiClient, AiModelType, PromptInput } from "../services/ai-client/index.js";

// -------------------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------------------

type State = {
  /** Whether this path is active (configured for openai) */
  active: boolean;
};

// -------------------------------------------------------------------------------------
// Consumer Definition
// -------------------------------------------------------------------------------------

const OpenAiConsumer: Consumer<State, AiClient> = {
  name: "openai",

  initial: { active: false },

  apply: (state, event) => {
    const modelChange = AiModelType.fromEventInput(event);
    return Option.isSome(modelChange) ? { active: modelChange.value === "openai" } : state;
  },

  react: (state, event, path, emit) =>
    Effect.gen(function* () {
      if (!state.active) return;

      const prompt = PromptInput.fromEventInput(event);
      if (Option.isNone(prompt)) return;

      const aiClient = yield* AiClient;

      yield* Effect.log(`OpenAI consumer: triggering generation for path=${path}`);

      yield* aiClient.prompt("openai", path, prompt.value).pipe(Stream.runForEach(emit));
    }),
};

// -------------------------------------------------------------------------------------
// Layer
// -------------------------------------------------------------------------------------

export const OpenAiConsumerLayer = toLayer(OpenAiConsumer);
