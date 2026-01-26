/**
 * Clock Processor
 *
 * Emits TimeTickEvent periodically to provide time awareness to other processors.
 * The tick interval is configurable (default: 10 seconds).
 *
 * This enables time-based reactions without relying on in-process timers that
 * wouldn't survive restarts. On replay, the processor simply hydrates from
 * existing TimeTickEvents without re-emitting.
 */
import { DateTime, Duration, Effect, Option, Schedule, Schema, Stream } from "effect";

import { Event, Offset } from "../../domain.js";
import { Processor, toLayer } from "../processor.js";
import { TimeTickEvent } from "./events.js";

// -------------------------------------------------------------------------------------
// Configuration
// -------------------------------------------------------------------------------------

/** Default tick interval in seconds */
const DEFAULT_TICK_INTERVAL_SECONDS = 10;

// -------------------------------------------------------------------------------------
// State
// -------------------------------------------------------------------------------------

class State extends Schema.Class<State>("ClockProcessor/State")({
  lastOffset: Offset,
  /** When the stream started (from first event's createdAt) */
  streamStartedAt: Schema.OptionFromNullOr(Schema.DateTimeUtc),
  /** The last emitted tick's elapsed seconds (to avoid duplicate ticks) */
  lastTickSeconds: Schema.Number,
}) {
  static initial = State.make({
    lastOffset: Offset.make("-1"),
    streamStartedAt: Option.none(),
    lastTickSeconds: -1,
  });
}

// -------------------------------------------------------------------------------------
// Reducer
// -------------------------------------------------------------------------------------

const reduce = (state: State, event: Event): State => {
  const base = { ...state, lastOffset: event.offset };

  // Track stream start time from first event
  if (Option.isNone(state.streamStartedAt)) {
    return State.make({
      ...base,
      streamStartedAt: Option.some(event.createdAt),
    });
  }

  // Track our own tick events (for replay)
  if (TimeTickEvent.is(event)) {
    return State.make({
      ...base,
      lastTickSeconds: event.payload.elapsedSeconds,
    });
  }

  return State.make(base);
};

// -------------------------------------------------------------------------------------
// Processor
// -------------------------------------------------------------------------------------

export const ClockProcessor: Processor<never> = {
  name: "clock",

  run: (stream) =>
    Effect.gen(function* () {
      // Phase 1: Hydrate from history
      let state = yield* stream.read().pipe(Stream.runFold(State.initial, reduce));

      yield* Effect.log(
        `hydrated, lastOffset=${state.lastOffset}, lastTickSeconds=${state.lastTickSeconds}`,
      );

      // Phase 2: Subscribe to live events to track stream start and our ticks
      const subscriptionFiber = yield* stream.subscribe({ from: state.lastOffset }).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            state = reduce(state, event);
          }),
        ),
        Effect.forkScoped,
      );

      // Phase 3: Emit ticks periodically
      // We use a schedule-based loop that checks elapsed time and emits if needed
      yield* Effect.gen(function* () {
        // Wait until we have a stream start time
        if (Option.isNone(state.streamStartedAt)) {
          yield* Effect.log("waiting for first event to determine stream start time");
          return;
        }

        const streamStartedAt = state.streamStartedAt.value;
        const now = yield* DateTime.now;
        const elapsed = DateTime.distanceDuration(streamStartedAt, now);
        const elapsedSeconds = Math.floor(Duration.toSeconds(elapsed));

        // Calculate which tick we should be at (round down to interval)
        const targetTick =
          Math.floor(elapsedSeconds / DEFAULT_TICK_INTERVAL_SECONDS) *
          DEFAULT_TICK_INTERVAL_SECONDS;

        // Only emit if we haven't emitted this tick yet
        if (targetTick > state.lastTickSeconds) {
          yield* Effect.log(`emitting tick at ${targetTick}s elapsed`);
          yield* stream.append(TimeTickEvent.make({ elapsedSeconds: targetTick }));
        }
      }).pipe(
        Effect.repeat(Schedule.spaced(Duration.seconds(DEFAULT_TICK_INTERVAL_SECONDS))),
        Effect.catchAllCause((cause) => Effect.logError("tick loop failed", cause)),
      );

      // Keep the subscription fiber alive
      yield* subscriptionFiber.await;
    }),
};

// -------------------------------------------------------------------------------------
// Layer
// -------------------------------------------------------------------------------------

export const ClockProcessorLayer = toLayer(ClockProcessor);
