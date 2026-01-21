/**
 * OpenAI Consumer
 *
 * Consumes stream events and triggers OpenAI generation when:
 * - The path is configured for "openai" model
 * - A user prompt event is received
 */
import { Effect, Layer, Option, Stream } from "effect";

import { Event, Offset, type StreamPath } from "../domain.js";
import { AiClient, AiModelType, PromptInput } from "../services/ai-client/index.js";
import { StreamManager } from "../services/stream-manager/index.js";

// -------------------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------------------

type PathState = {
  /** Whether this path is active (configured for openai) */
  active: boolean;
};

const initialPathState: PathState = { active: false };

// -------------------------------------------------------------------------------------
// Event Processing
// -------------------------------------------------------------------------------------

/** Update state based on config events. Returns new state. */
const applyEvent = (state: PathState, event: Event): PathState => {
  const modelChange = AiModelType.fromEventInput(event);
  if (Option.isSome(modelChange)) {
    return { active: modelChange.value === "openai" };
  }
  return state;
};

/** Check if we should respond to this event */
const shouldRespond = (state: PathState, event: Event): boolean => {
  if (!state.active) return false;
  return Option.isSome(PromptInput.fromEventInput(event));
};

// -------------------------------------------------------------------------------------
// Consumer Layer
// -------------------------------------------------------------------------------------

/**
 * OpenAI Consumer Layer
 *
 * Subscribes to all streams and triggers OpenAI generation for prompt events
 * on paths configured for openai.
 *
 * Uses Layer.scopedDiscard because this is a background process, not a service.
 * It doesn't provide a tag - it just runs for the lifetime of whatever layer
 * it's provided to (the server). When the server shuts down, this consumer
 * shuts down gracefully with it.
 */
export const OpenAiConsumer: Layer.Layer<never, never, StreamManager | AiClient> =
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const streamManager = yield* StreamManager;
      const aiClient = yield* AiClient;

      // Per-path state
      const stateByPath = new Map<StreamPath, PathState>();

      const getState = (path: StreamPath): PathState => stateByPath.get(path) ?? initialPathState;

      const setState = (path: StreamPath, state: PathState): void => {
        stateByPath.set(path, state);
      };

      yield* Effect.log("OpenAI consumer: starting");

      // Phase 1: Hydrate state from historical events (don't trigger AI)
      let lastOffset = Offset.make("-1");
      yield* streamManager.subscribe({ live: false }).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            const path = event.path;
            const oldState = getState(path);
            const newState = applyEvent(oldState, event);
            setState(path, newState);
            lastOffset = event.offset;
          }),
        ),
        Effect.catchAllCause((cause) =>
          Effect.logError("OpenAI consumer: failed to hydrate from history", cause),
        ),
      );

      yield* Effect.log(
        `OpenAI consumer: hydrated state from history, lastOffset=${lastOffset}, paths=${stateByPath.size}`,
      );

      // Phase 2: Subscribe to new events only (after lastOffset)
      yield* streamManager.subscribe({ live: true, after: lastOffset }).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const path = event.path;

            yield* Effect.log(
              `OpenAI consumer: new event path=${path} type=${event.type} offset=${event.offset}`,
            );

            // Update state for this path
            const oldState = getState(path);
            const newState = applyEvent(oldState, event);
            setState(path, newState);

            // Check if we need to respond
            if (!shouldRespond(newState, event)) return;

            const promptInput = PromptInput.fromEventInput(event);
            if (Option.isNone(promptInput)) return;

            yield* Effect.log(`OpenAI consumer: triggering generation for path=${path}`);

            // Stream AI response back to the stream
            yield* aiClient
              .prompt("openai", path, promptInput.value)
              .pipe(
                Stream.runForEach((responseEvent) =>
                  streamManager.append({ path, event: responseEvent }),
                ),
              );
          }),
        ),
        Effect.catchAllCause((cause) => Effect.logError("OpenAI consumer error", cause)),
        Effect.forkScoped,
      );
    }),
  );
