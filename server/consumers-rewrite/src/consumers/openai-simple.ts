/**
 * OpenAI Consumer (Simple)
 *
 * Triggers OpenAI generation when:
 * - The path is configured for "openai" model
 * - A user prompt event is received
 *
 * Implemented using the SimpleConsumer interface.
 */
import { Effect, Option, Stream } from "effect";

import { Event, Offset } from "../domain.js";
import { AiClient, AiModelType, PromptInput } from "../services/ai-client/index.js";
import { SimpleConsumer, toLayer } from "./simple-consumer.js";

// -------------------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------------------

type State = {
  active: boolean;
  lastOffset: Offset;
};

const initialState: State = { active: false, lastOffset: Offset.make("-1") };

const reduce = (state: State, event: Event): State => {
  const modelChange = AiModelType.fromEventInput(event);
  return {
    active: Option.isSome(modelChange) ? modelChange.value === "openai" : state.active,
    lastOffset: event.offset,
  };
};

// -------------------------------------------------------------------------------------
// Consumer
// -------------------------------------------------------------------------------------

const OpenAiSimpleConsumer: SimpleConsumer<AiClient> = {
  name: "openai",

  run: (stream) =>
    Effect.gen(function* () {
      const aiClient = yield* AiClient;

      // Phase 1: Hydrate from history
      let state = yield* stream.read().pipe(Stream.runFold(initialState, reduce));

      yield* Effect.log(`hydrated, lastOffset=${state.lastOffset}, active=${state.active}`);

      // Phase 2: Subscribe to live events
      yield* stream.subscribe({ from: state.lastOffset }).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            state = reduce(state, event);

            if (!state.active) return;

            const prompt = PromptInput.fromEventInput(event);
            if (Option.isNone(prompt)) return;

            yield* Effect.log("triggering generation");

            yield* aiClient
              .prompt("openai", stream.path, prompt.value)
              .pipe(Stream.runForEach(stream.append));
          }),
        ),
      );
    }),
};

// -------------------------------------------------------------------------------------
// Layer
// -------------------------------------------------------------------------------------

export const OpenAiSimpleConsumerLayer = toLayer(OpenAiSimpleConsumer);
