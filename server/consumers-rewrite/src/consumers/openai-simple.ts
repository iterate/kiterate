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
import { Cause, Effect, Exit, Fiber, Option, Schema, Stream } from "effect";

import { Event, EventInput, EventType, Offset } from "../domain.js";
import { AiModelType } from "../services/ai-client/index.js";
import { SimpleConsumer, toLayer } from "./simple-consumer.js";

// -------------------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------------------

type State = {
  enabled: boolean;
  lastOffset: Offset;
  history: Array<Prompt.MessageEncoded>;
  /** Offset of most recent user message requiring LLM response */
  llmRequestRequiredFrom: Option.Option<Offset>;
  /** Offset of most recent request-started (never cleared, used for trigger comparison) */
  llmLastRespondedAt: Option.Option<Offset>;
};

const initialState: State = {
  enabled: false,
  lastOffset: Offset.make("-1"),
  history: [],
  llmRequestRequiredFrom: Option.none(),
  llmLastRespondedAt: Option.none(),
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
    return { ...base, enabled: modelChange.value === "openai" };
  }

  // User message - add to history and mark offset as pending
  if (event.type === "iterate:agent:action:send-user-message:called") {
    const content = event.payload["content"];
    if (typeof content === "string") {
      return {
        ...base,
        history: [...state.history, { role: "user", content }],
        llmRequestRequiredFrom: Option.some(event.offset),
      };
    }
  }

  // Request started - track that we've responded to the current user message
  if (event.type === "iterate:openai:request-started") {
    return { ...base, llmLastRespondedAt: Option.some(event.offset) };
  }
  // request-ended and request-cancelled don't affect state
  // (in-flight tracking is handled by currentFiber locally)

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
        `hydrated, lastOffset=${state.lastOffset}, enabled=${state.enabled}, history=${state.history.length} messages, pending=${Option.getOrNull(state.llmRequestRequiredFrom)}`,
      );

      // Ongoing LLM request fiber
      let currentFiber: Fiber.RuntimeFiber<void, never> | null = null;

      // Phase 2: Subscribe to live events
      yield* stream.subscribe({ from: state.lastOffset }).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            state = reduce(state, event);

            if (!state.enabled) return;

            // Trigger if there's a user message newer than our last request-started
            const shouldTriggerLlmResponse = Option.match(state.llmRequestRequiredFrom, {
              onNone: () => false,
              onSome: (requiredFrom) =>
                Option.match(state.llmLastRespondedAt, {
                  onNone: () => true,
                  onSome: (startedAt) => Offset.gt(requiredFrom, startedAt),
                }),
            });
            if (!shouldTriggerLlmResponse) return;

            yield* Effect.log(`triggering generation, history=${state.history.length} messages`);

            // 1. Emit request-started FIRST (before interrupt) so it gets a lower offset
            //    and arrives before any cancellation events from the old request
            const requestOffset = yield* stream.append(
              EventInput.make({
                type: EventType.make("iterate:openai:request-started"),
                payload: {},
              }),
            );

            // 2. Cancel ongoing LLM request if any
            if (currentFiber) {
              const interruptedRequestOffset = state.llmLastRespondedAt;
              const fiber = currentFiber;
              currentFiber = null;
              yield* Fiber.interrupt(fiber);
              yield* stream.append(
                EventInput.make({
                  type: EventType.make("iterate:openai:request-interrupted"),
                  payload: { requestOffset: Option.getOrNull(interruptedRequestOffset) },
                }),
              );
            }

            // 3. Fork the LLM stream with lifecycle events on exit
            currentFiber = yield* lm.streamText({ prompt: state.history }).pipe(
              Stream.runForEach((part) =>
                stream.append(
                  EventInput.make({
                    type: EventType.make("iterate:openai:response:sse"),
                    payload: { part, requestOffset },
                  }),
                ),
              ),
              Effect.ensuring(Effect.sync(() => (currentFiber = null))),
              Effect.onExit((exit) =>
                Exit.match(exit, {
                  onSuccess: () =>
                    stream.append(
                      EventInput.make({
                        type: EventType.make("iterate:openai:request-ended"),
                        payload: { requestOffset },
                      }),
                    ),
                  onFailure: (cause) =>
                    Effect.gen(function* () {
                      yield* Effect.logError("generation failed", cause);
                      yield* stream.append(
                        EventInput.make({
                          type: EventType.make("iterate:openai:request-cancelled"),
                          payload: {
                            requestOffset,
                            reason: Cause.isInterruptedOnly(cause) ? "interrupted" : "error",
                            message: Cause.pretty(cause),
                          },
                        }),
                      );
                    }),
                }),
              ),
              Effect.catchAllCause(() => Effect.void),
              Effect.fork,
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
