/**
 * Effect AI Processor
 *
 * Uses @effect/ai LanguageModel to trigger LLM generation when:
 * - The path is configured for "openai" model
 * - A user prompt event is received
 *
 * Maintains conversation history and sends it with each request.
 */
import { LanguageModel, Prompt } from "@effect/ai";
import { Cause, Effect, Exit, Fiber, Option, Schema, Stream, type Types } from "effect";

import { Event, Offset } from "../domain.js";
import {
  ConfigSetEvent,
  RequestCancelledEvent,
  RequestEndedEvent,
  RequestInterruptedEvent,
  RequestStartedEvent,
  ResponseSseEvent,
  UserMessageEvent,
} from "../events.js";
import { SimpleProcessor, toLayer } from "./simple-processor.js";

// -------------------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------------------

class State extends Schema.Class<State>("EffectAiProcessor/State")({
  enabled: Schema.Boolean,
  lastOffset: Offset,
  history: Schema.Array(Schema.encodedSchema(Prompt.Message)),
  /** Offset of most recent user message requiring LLM response */
  llmRequestRequiredFrom: Schema.Option(Offset),
  /** Offset of most recent request-started (never cleared, used for trigger comparison) */
  llmLastRespondedAt: Schema.Option(Offset),
}) {
  static initial = State.make({
    enabled: false,
    lastOffset: Offset.make("-1"),
    history: [],
    llmRequestRequiredFrom: Option.none(),
    llmLastRespondedAt: Option.none(),
  });

  /** True if there's a user message newer than our last response */
  get shouldTriggerLlmResponse(): boolean {
    if (Option.isNone(this.llmRequestRequiredFrom)) return false;
    if (Option.isNone(this.llmLastRespondedAt)) return true;
    return Offset.gt(this.llmRequestRequiredFrom.value, this.llmLastRespondedAt.value);
  }

  /** Append text delta to conversation history, creating or extending assistant message */
  appendAssistantDelta(delta: string): Types.Simplify<State> {
    const last = this.history.at(-1);
    if (last?.role === "assistant") {
      return State.make({
        ...this,
        history: [...this.history.slice(0, -1), { ...last, content: last.content + delta }],
      });
    }
    return State.make({
      ...this,
      history: [...this.history, { role: "assistant", content: delta }],
    });
  }
}

// -------------------------------------------------------------------------------------
// Reducer
// -------------------------------------------------------------------------------------

// TODO(claude): Possibly eventually export a Reducer for this that contains the State
const reduce = (state: State, event: Event): State => {
  const base = { ...state, lastOffset: event.offset };

  // Config change
  if (ConfigSetEvent.is(event)) {
    return State.make({ ...base, enabled: event.payload.model === "openai" });
  }

  // TODO(claude): Something like this plz
  // import * as EffectAiEvents from "processors/effect-ai/events"

  // User message - add to history and mark offset as pending
  if (UserMessageEvent.is(event)) {
    return State.make({
      ...base,
      history: [...state.history, { role: "user", content: event.payload.content }],
      llmRequestRequiredFrom: Option.some(event.offset),
    });
  }

  // Request started - track that we've responded to the current user message
  if (RequestStartedEvent.is(event)) {
    return State.make({ ...base, llmLastRespondedAt: Option.some(event.offset) });
  }
  // request-ended and request-cancelled don't affect state
  // (in-flight tracking is handled by currentFiber locally)

  // Assistant response - parse our own emitted SSE events
  if (ResponseSseEvent.is(event)) {
    const textDelta = ResponseSseEvent.decodeTextDelta(event.payload.part);
    if (Option.isSome(textDelta)) {
      return State.make({ ...base }).appendAssistantDelta(textDelta.value.delta);
    }
  }

  return State.make(base);
};

// -------------------------------------------------------------------------------------
// Processor
// -------------------------------------------------------------------------------------

export const EffectAiProcessor: SimpleProcessor<LanguageModel.LanguageModel> = {
  name: "effect-ai",

  run: (stream) =>
    Effect.gen(function* () {
      const lm = yield* LanguageModel.LanguageModel;

      // Phase 1: Hydrate from history
      let state = yield* stream.read().pipe(Stream.runFold(State.initial, reduce));

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
            if (!state.shouldTriggerLlmResponse) return;

            yield* Effect.log(`triggering generation, history=${state.history.length} messages`);

            // 1. Emit request-started FIRST (before interrupt) so it gets a lower offset
            //    and arrives before any cancellation events from the old request
            const requestOffset = yield* stream.append(RequestStartedEvent.make());

            // 2. Cancel ongoing LLM request if any
            if (currentFiber) {
              const interruptedRequestOffset = state.llmLastRespondedAt;
              const fiber = currentFiber;
              currentFiber = null;
              yield* Fiber.interrupt(fiber);
              yield* stream.append(
                RequestInterruptedEvent.make({
                  requestOffset: Option.getOrNull(interruptedRequestOffset),
                }),
              );
            }

            // 3. Fork the LLM stream with lifecycle events on exit
            currentFiber = yield* lm.streamText({ prompt: state.history }).pipe(
              Stream.runForEach((part) =>
                stream.append(ResponseSseEvent.make({ part, requestOffset })),
              ),
              Effect.ensuring(Effect.sync(() => (currentFiber = null))),
              Effect.onExit((exit) =>
                Exit.match(exit, {
                  onSuccess: () => stream.append(RequestEndedEvent.make({ requestOffset })),
                  onFailure: (cause) =>
                    Effect.gen(function* () {
                      yield* Effect.logError("generation failed", cause);
                      yield* stream.append(
                        RequestCancelledEvent.make({
                          requestOffset,
                          reason: Cause.isInterruptedOnly(cause) ? "interrupted" : "error",
                          message: Cause.pretty(cause),
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

export const EffectAiProcessorLayer = toLayer(EffectAiProcessor);
