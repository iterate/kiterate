/**
 * Consumer Abstraction
 *
 * A framework for building path-local stream consumers that:
 * - Track state per path
 * - Hydrate from historical events (apply only, no side effects)
 * - React to live events (apply + side effects)
 */
import { Effect, Layer, Stream } from "effect";

import { Event, EventInput, Offset, type StreamPath } from "../domain.js";
import { StreamManager } from "../services/stream-manager/index.js";

// -------------------------------------------------------------------------------------
// Consumer Definition
// -------------------------------------------------------------------------------------

/**
 * A consumer definition - the core logic without boilerplate.
 *
 * @template S - State type (per-path)
 * @template R - Dependencies required by react()
 */
export interface Consumer<S, R> {
  /** Consumer name for logging */
  readonly name: string;

  /** Initial state for new paths */
  readonly initial: S;

  /**
   * Pure state reducer. Called for both historical and live events.
   * Should not perform side effects.
   */
  readonly apply: (state: S, event: Event) => S;

  /**
   * Side-effectful reaction to live events.
   * Called after apply() for live events only (not during hydration).
   *
   * @param state - Current state after apply()
   * @param event - The event that triggered this reaction
   * @param path - The stream path
   * @param emit - Function to emit events back to the stream
   */
  readonly react: (
    state: S,
    event: Event,
    path: StreamPath,
    emit: (event: EventInput) => Effect.Effect<void>,
  ) => Effect.Effect<void, never, R>;
}

// -------------------------------------------------------------------------------------
// Consumer Runner
// -------------------------------------------------------------------------------------

/**
 * Convert a Consumer definition into a Layer.
 *
 * Handles all the boilerplate:
 * - Per-path state management
 * - Hydration from historical events
 * - Live subscription with reactions
 */
export const toLayer = <S, R>(
  consumer: Consumer<S, R>,
): Layer.Layer<never, never, StreamManager | R> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const streamManager = yield* StreamManager;
      const context = yield* Effect.context<R>();

      // Per-path state with combined get/apply/set
      const stateByPath = new Map<StreamPath, S>();

      const applyEvent = (event: Event): S => {
        const old = stateByPath.get(event.path) ?? consumer.initial;
        const next = consumer.apply(old, event);
        stateByPath.set(event.path, next);
        return next;
      };

      const emit = (path: StreamPath) => (input: EventInput) =>
        streamManager
          .append({ path, event: input })
          .pipe(Effect.catchAllCause((cause) => Effect.logError("emit failed", cause)));

      yield* Effect.log("starting");

      // Phase 1: Hydrate state from historical events (no reactions)
      const lastOffset = yield* streamManager.subscribe({ live: false }).pipe(
        Stream.runFold(Offset.make("-1"), (_, event) => {
          applyEvent(event);
          return event.offset;
        }),
        Effect.catchAllCause((cause) =>
          Effect.as(Effect.logError("hydration failed", cause), Offset.make("-1")),
        ),
      );

      yield* Effect.log(`hydrated, lastOffset=${lastOffset}, paths=${stateByPath.size}`);

      // Phase 2: Subscribe to live events (apply + react)
      yield* streamManager.subscribe({ live: true, after: lastOffset }).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const newState = applyEvent(event);
            yield* consumer
              .react(newState, event, event.path, emit(event.path))
              .pipe(Effect.provide(context));
          }),
        ),
        Effect.catchAllCause((cause) => Effect.logError("error", cause)),
        Effect.forkScoped,
      );
    }).pipe(Effect.annotateLogs("consumer", consumer.name)),
  );
