/**
 * LLM Loop Processor
 *
 * Uses @effect/ai LanguageModel to trigger LLM generation when:
 * - The path is configured for "openai" model
 * - A user prompt event is received
 *
 * Maintains conversation history and sends it with each request.
 */
import { LanguageModel, Prompt } from "@effect/ai";
import { Cause, Duration, Effect, Exit, Option, Schema, Stream } from "effect";

import dedent from "dedent";
import { Event, Offset } from "../../domain.js";
import { CancelRequestEvent, ConfigSetEvent, UserMessageEvent } from "../../events.js";
import { Processor, toLayer } from "../processor.js";
import { makeDebounced } from "../../utils/debounce.js";
import { withTraceFromEvent } from "../../tracing/helpers.js";
import { makeActiveRequestFiber } from "./activeRequestFiber.js";
import {
  RequestCancelledEvent,
  RequestEndedEvent,
  RequestInterruptedEvent,
  RequestStartedEvent,
  ResponseSseEvent,
  SystemPromptEditEvent,
} from "./events.js";

// -------------------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------------------

/** Default base system prompt */
const DEFAULT_SYSTEM_PROMPT = dedent`
  You are a helpful assistant.

  You should aim to "get things done". Be as proactive as possible. If you fail at a task, rather than asking "do you want me to search for XYZ?", you should aim to find a way to just search for XYZ yourself and and see if it does indeed help you complete the task.
`;

class State extends Schema.Class<State>("LlmLoopProcessor/State")({
  enabled: Schema.Boolean,
  lastOffset: Offset,
  history: Schema.Array(Schema.encodedSchema(Prompt.Message)),
  /** Offset of most recent user message requiring LLM response */
  llmRequestRequiredFrom: Schema.Option(Offset),
  /** Offset of most recent request-started (never cleared, used for trigger comparison) */
  llmLastRespondedAt: Schema.Option(Offset),
  /** Current system prompt (built from edits) */
  systemPrompt: Schema.String,
  /** Whether there's a queued message waiting for the current response to finish */
  pendingQueuedResponse: Schema.Boolean,
}) {
  static initial = State.make({
    enabled: false,
    lastOffset: Offset.make("-1"),
    history: [],
    llmRequestRequiredFrom: Option.none(),
    llmLastRespondedAt: Option.none(),
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    pendingQueuedResponse: false,
  });

  /** Create a new State with the given updates */
  with(updates: Partial<typeof State.Type>): State {
    return State.make({ ...this, ...updates });
  }

  /** True if there's a user message newer than our last response */
  get shouldTriggerLlmResponse(): boolean {
    if (Option.isNone(this.llmRequestRequiredFrom)) return false;
    if (Option.isNone(this.llmLastRespondedAt)) return true;
    return Offset.gt(this.llmRequestRequiredFrom.value, this.llmLastRespondedAt.value);
  }

  /** Append text delta to conversation history, creating or extending assistant message */
  appendAssistantDelta(delta: string): State {
    const last = this.history.at(-1);
    if (last?.role === "assistant") {
      return this.with({
        history: [...this.history.slice(0, -1), { ...last, content: last.content + delta }],
      });
    }
    return this.with({
      history: [...this.history, { role: "assistant", content: delta }],
    });
  }
}

type History = State["history"];

// -------------------------------------------------------------------------------------
// Reducer
// -------------------------------------------------------------------------------------

// TODO(claude): Possibly eventually export a Reducer for this that contains the State
const reduce = (state: State, event: Event): State => {
  state = state.with({ lastOffset: event.offset });

  // Config change
  if (ConfigSetEvent.is(event)) {
    const nowEnabled = event.payload.model === "openai";
    return state.with({ enabled: nowEnabled });
  }

  // System prompt edit
  if (SystemPromptEditEvent.is(event)) {
    const { mode, content } = event.payload;
    let newPrompt: string;
    switch (mode) {
      case "replace":
        newPrompt = content;
        break;
      case "prepend":
        newPrompt = content + "\n\n" + state.systemPrompt;
        break;
      case "append":
        newPrompt = state.systemPrompt + "\n\n" + content;
        break;
    }
    return state.with({ systemPrompt: newPrompt });
  }

  // User message - add to history and handle mode
  if (UserMessageEvent.is(event)) {
    const mode = event.payload.mode ?? "interrupt";
    const newState = state.with({
      history: [...state.history, { role: "user", content: event.payload.content }],
    });

    switch (mode) {
      case "interrupt":
        return newState.with({
          llmRequestRequiredFrom: Option.some(event.offset),
          pendingQueuedResponse: false,
        });
      case "queue":
        return newState.with({ pendingQueuedResponse: true });
      case "background":
        return newState;
    }
  }

  // Request started - track that we've responded to the current user message
  if (RequestStartedEvent.is(event)) {
    return state.with({ llmLastRespondedAt: Option.some(event.offset) });
  }

  // Request ended - trigger queued response if pending
  if (RequestEndedEvent.is(event) && state.pendingQueuedResponse) {
    return state.with({
      llmRequestRequiredFrom: Option.some(event.offset),
      pendingQueuedResponse: false,
    });
  }

  // Request cancelled due to interrupt - mark the partial response so LLM knows it was cut off
  if (RequestCancelledEvent.is(event) && event.payload.reason === "interrupted") {
    const last = state.history.at(-1);
    if (last?.role === "assistant") {
      return state.with({
        history: [
          ...state.history.slice(0, -1),
          { ...last, content: last.content + "\n\n[response interrupted by user]" },
        ],
      });
    }
  }

  // Assistant response - parse our own emitted SSE events
  if (ResponseSseEvent.is(event)) {
    const textDelta = ResponseSseEvent.decodeTextDelta(event.payload.part);
    if (Option.isSome(textDelta)) {
      return state.appendAssistantDelta(textDelta.value.delta);
    }
  }

  return state;
};

/** Debounce settings for LLM requests */
export const llmDebounce = {
  duration: Duration.millis(200),
  maxWait: Duration.seconds(2),
};

// -------------------------------------------------------------------------------------
// Processor
// -------------------------------------------------------------------------------------

export const LlmLoopProcessor: Processor<LanguageModel.LanguageModel> = {
  name: "llm-loop",

  run: (stream) =>
    Effect.gen(function* () {
      const lm = yield* LanguageModel.LanguageModel;

      // Phase 1: Hydrate from history
      let state = yield* stream.read().pipe(Stream.runFold(State.initial, reduce));

      yield* Effect.log(
        `hydrated, lastOffset=${state.lastOffset}, enabled=${state.enabled}, history=${state.history.length} messages, pending=${Option.getOrNull(state.llmRequestRequiredFrom)}`,
      );

      const activeRequestFiber = yield* makeActiveRequestFiber();

      const startRequest = Effect.fn("llm-loop.request")(function* ({
        history,
        systemPrompt,
      }: {
        history: History;
        systemPrompt: string;
      }) {
        // Build prompt with system message
        const prompt: Prompt.MessageEncoded[] = [
          { role: "system", content: systemPrompt },
          ...history,
        ];

        const { offset: requestOffset } = yield* stream.append(
          RequestStartedEvent.make({ requestParams: prompt }),
        );

        // Annotate span with request context
        yield* Effect.annotateCurrentSpan("request.offset", requestOffset);
        yield* Effect.annotateCurrentSpan("request.message_count", history.length + 1);

        yield* Effect.log(`triggering generation, history=${history.length} messages`);

        const requestEffect = lm.streamText({ prompt }).pipe(
          Stream.runForEach((part) =>
            stream.append(ResponseSseEvent.make({ part, requestOffset })),
          ),
          Effect.onExit((exit) =>
            Exit.match(exit, {
              onSuccess: () =>
                stream.append(RequestEndedEvent.make({ requestOffset })).pipe(Effect.asVoid),
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
        );

        const previousRequestOffset = yield* activeRequestFiber.run(requestOffset, requestEffect);
        if (Option.isSome(previousRequestOffset)) {
          yield* stream.append(
            RequestInterruptedEvent.make({
              requestOffset: previousRequestOffset.value,
            }),
          );
        }
      });

      const debounced = yield* makeDebounced(startRequest, llmDebounce);

      // Phase 2: Subscribe to live events
      yield* stream.subscribe({ from: state.lastOffset }).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            // Handle cancel request - interrupt current response without triggering new one
            if (CancelRequestEvent.is(event)) {
              const currentOffset = activeRequestFiber.currentOffset;
              if (Option.isSome(currentOffset)) {
                yield* activeRequestFiber.interruptOnly();
                yield* stream.append(
                  RequestInterruptedEvent.make({
                    requestOffset: currentOffset.value,
                  }),
                );
              }
              return;
            }

            state = reduce(state, event);

            // !enabled only blocks future triggers; pending debounced runs still execute.
            if (!state.enabled) return;
            if (!state.shouldTriggerLlmResponse) return;

            // Trigger LLM request (debounced) - pass event for trace context
            yield* debounced
              .trigger({
                history: state.history,
                systemPrompt: state.systemPrompt,
              })
              .pipe(withTraceFromEvent(event));
          }),
        ),
      );
    }),
};

// -------------------------------------------------------------------------------------
// Layer
// -------------------------------------------------------------------------------------

export const LlmLoopProcessorLayer = toLayer(LlmLoopProcessor);
