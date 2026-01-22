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
import {
  Cause,
  Duration,
  Effect,
  Exit,
  FiberMap,
  Option,
  Ref,
  Schema,
  Stream,
  type Scope,
} from "effect";

import { Event, Offset } from "../../domain.js";
import { ConfigSetEvent, UserMessageEvent } from "../../events.js";
import { Processor, toLayer } from "../processor.js";
import { makeDebounced } from "../../utils/debounce.js";
import {
  RequestCancelledEvent,
  RequestEndedEvent,
  RequestInterruptedEvent,
  RequestStartedEvent,
  ResponseSseEvent,
} from "./events.js";

// -------------------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------------------

class State extends Schema.Class<State>("LlmLoopProcessor/State")({
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

type ActiveRequestFiber = {
  readonly replace: (requestOffset: Offset) => Effect.Effect<Option.Option<Offset>>;
  readonly run: <R>(
    requestOffset: Offset,
    effect: Effect.Effect<void, never, R>,
  ) => Effect.Effect<void, never, R>;
  readonly currentOffset: Effect.Effect<Option.Option<Offset>>;
};

// -------------------------------------------------------------------------------------
// Reducer
// -------------------------------------------------------------------------------------

// TODO(claude): Possibly eventually export a Reducer for this that contains the State
const reduce = (state: State, event: Event): State => {
  state = state.with({ lastOffset: event.offset });

  // Config change
  if (ConfigSetEvent.is(event)) {
    return state.with({ enabled: event.payload.model === "openai" });
  }

  // User message - add to history and mark offset as pending
  if (UserMessageEvent.is(event)) {
    return state.with({
      history: [...state.history, { role: "user", content: event.payload.content }],
      llmRequestRequiredFrom: Option.some(event.offset),
    });
  }

  // Request started - track that we've responded to the current user message
  if (RequestStartedEvent.is(event)) {
    return state.with({ llmLastRespondedAt: Option.some(event.offset) });
  }
  // request-ended and request-cancelled don't affect state
  // (in-flight tracking is handled by FiberMap locally)

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

const makeActiveRequestFiber = (): Effect.Effect<ActiveRequestFiber, never, Scope.Scope> =>
  Effect.gen(function* () {
    const map = yield* FiberMap.make<"active", void>();
    const offsetRef = yield* Ref.make<Option.Option<Offset>>(Option.none());

    const replace = (requestOffset: Offset) =>
      Ref.modify(offsetRef, (current): [Option.Option<Offset>, Option.Option<Offset>] => [
        current,
        Option.some(requestOffset),
      ]);

    const clearIfActive = (requestOffset: Offset) =>
      Ref.update(offsetRef, (current) => {
        if (Option.isSome(current) && current.value === requestOffset) {
          return Option.none();
        }
        return current;
      });

    const run = <R>(requestOffset: Offset, effect: Effect.Effect<void, never, R>) =>
      FiberMap.run(map, "active", effect.pipe(Effect.ensuring(clearIfActive(requestOffset))), {
        propagateInterruption: true,
      }).pipe(Effect.asVoid);

    return {
      replace,
      run,
      currentOffset: Ref.get(offsetRef),
    };
  });

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

      const startRequest = (history: History) =>
        Effect.gen(function* () {
          const requestOffset = yield* stream.append(RequestStartedEvent.make());
          const previousRequestOffset = yield* activeRequestFiber.replace(requestOffset);
          if (Option.isSome(previousRequestOffset)) {
            yield* stream.append(
              RequestInterruptedEvent.make({
                requestOffset: previousRequestOffset.value,
              }),
            );
          }

          yield* Effect.log(`triggering generation, history=${history.length} messages`);

          const requestEffect = lm.streamText({ prompt: history }).pipe(
            Stream.runForEach((part) =>
              stream.append(ResponseSseEvent.make({ part, requestOffset })),
            ),
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
          );

          yield* activeRequestFiber.run(requestOffset, requestEffect);
        });

      const debounced = yield* makeDebounced(startRequest, llmDebounce);

      // Phase 2: Subscribe to live events
      yield* stream.subscribe({ from: state.lastOffset }).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            state = reduce(state, event);

            // !enabled only blocks future triggers; pending debounced runs still execute.
            if (!state.enabled) return;
            if (!state.shouldTriggerLlmResponse) return;

            yield* debounced.trigger(state.history);
          }),
        ),
      );
    }),
};

// -------------------------------------------------------------------------------------
// Layer
// -------------------------------------------------------------------------------------

export const LlmLoopProcessorLayer = toLayer(LlmLoopProcessor);
