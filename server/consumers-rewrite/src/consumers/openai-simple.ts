/**
 * OpenAI Consumer (Simple)
 *
 * Triggers OpenAI generation when:
 * - The path is configured for "openai" model
 * - A user prompt event is received
 *
 * Maintains conversation history and sends it with each request.
 */
import { LanguageModel, Prompt, Response } from "@effect/ai";
import { Effect, Exit, Option, Schema, Stream } from "effect";

import { Event, EventInput, EventType, Offset } from "../domain.js";
import { AiModelType } from "../services/ai-client/index.js";
import { SimpleConsumer, toLayer } from "./simple-consumer.js";

// -------------------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------------------

type State = {
  active: boolean;
  lastOffset: Offset;
  history: Array<Prompt.MessageEncoded>;
  llmRequestStartedAt: Option.Option<Offset>;
};

const initialState: State = {
  active: false,
  lastOffset: Offset.make("-1"),
  history: [],
  llmRequestStartedAt: Option.none(),
};

const decodeTextDelta = Schema.decodeUnknownOption(Response.TextDeltaPart);

// -------------------------------------------------------------------------------------
// Reducer
// -------------------------------------------------------------------------------------

const reduce = (state: State, event: Event): State => {
  const base = { ...state, lastOffset: event.offset };

  // Config change
  const modelChange = AiModelType.fromEventInput(event);
  if (Option.isSome(modelChange)) {
    return { ...base, active: modelChange.value === "openai" };
  }

  // User message - add to history
  // Make parse.
  if (event.type === "iterate:agent:action:send-user-message:called") {
    const content = event.payload["content"];
    if (typeof content === "string") {
      return {
        ...base,
        history: [...state.history, { role: "user", content }],
      };
    } else {
      throw new Error("I hate typescript");
    }
  }

  // Request lifecycle events
  if (event.type === "iterate:openai:request-started") {
    return { ...base, llmRequestStartedAt: Option.some(event.offset) };
  }
  if (event.type === "iterate:openai:request-ended") {
    return { ...base, llmRequestStartedAt: Option.none() };
  }
  if (event.type === "iterate:openai:request-cancelled") {
    return { ...base, llmRequestStartedAt: Option.none() };
  }

  // Assistant response - parse our own emitted SSE events
  if (event.type === "iterate:openai:response:sse") {
    const part = event.payload["part"];

    // Append text delta directly to history
    const textDelta = decodeTextDelta(part);
    if (Option.isSome(textDelta)) {
      const last = state.history.at(-1);
      if (last?.role === "assistant") {
        return {
          ...base,
          history: [
            ...state.history.slice(0, -1),
            { ...last, content: last.content + textDelta.value.delta },
          ],
        };
      }
      return {
        ...base,
        history: [...state.history, { role: "assistant", content: textDelta.value.delta }],
      };
    }
  }

  return base;
};

/** Check if event is a user prompt we should respond to */
const isUserPrompt = (event: Event): boolean =>
  event.type === "iterate:agent:action:send-user-message:called" &&
  typeof event.payload["content"] === "string";

// -------------------------------------------------------------------------------------
// Consumer
// -------------------------------------------------------------------------------------

const OpenAiSimpleConsumer: SimpleConsumer<LanguageModel.LanguageModel> = {
  name: "openai",

  run: (stream) =>
    Effect.gen(function* () {
      const lm = yield* LanguageModel.LanguageModel;

      // Phase 1: Hydrate from history
      let state = yield* stream.read().pipe(Stream.runFold(initialState, reduce));

      yield* Effect.log(
        `hydrated, lastOffset=${state.lastOffset}, active=${state.active}, history=${state.history.length} messages`,
      );

      // Phase 2: Subscribe to live events
      yield* stream.subscribe({ from: state.lastOffset }).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            state = reduce(state, event);

            if (!state.active) return;
            if (!isUserPrompt(event)) return;

            yield* Effect.log(`triggering generation, history=${state.history.length} messages`);

            // 1. Emit request-started
            yield* stream.append(
              EventInput.make({
                type: EventType.make("iterate:openai:request-started"),
                payload: {},
              }),
            );

            // 2. Stream response with lifecycle events on exit
            yield* lm.streamText({ prompt: state.history }).pipe(
              Stream.runForEach((part) =>
                stream.append(
                  EventInput.make({
                    type: EventType.make("iterate:openai:response:sse"),
                    payload: { part },
                  }),
                ),
              ),
              Effect.onExit((exit) =>
                Exit.match(exit, {
                  onSuccess: () =>
                    stream.append(
                      EventInput.make({
                        type: EventType.make("iterate:openai:request-ended"),
                        payload: {},
                      }),
                    ),
                  onFailure: (cause) =>
                    Effect.gen(function* () {
                      yield* Effect.logError("generation failed", cause);
                      yield* stream.append(
                        EventInput.make({
                          type: EventType.make("iterate:openai:request-cancelled"),
                          payload: { error: "generation_failed" },
                        }),
                      );
                    }),
                }),
              ),
              Effect.catchAllCause(() => Effect.void),
            );
          }),
        ),
      );
    }),
};

// -------------------------------------------------------------------------------------
// Layer
// -------------------------------------------------------------------------------------

export const OpenAiSimpleConsumerLayer = toLayer(OpenAiSimpleConsumer);
