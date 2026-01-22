/**
 * EventStream - single stream with history and replay
 *
 * Boot: reads history → reduces to derived state (current offset)
 * EventStream owns offset management, storage is dumb (just persists Events)
 */
import { DateTime, Effect, PubSub, Schema, Stream } from "effect";

import { Event, EventInput, Offset, StreamPath } from "../../domain.js";
import { StreamStorage } from "../stream-storage/service.js";

// -------------------------------------------------------------------------------------
// State (derived from event history)
// -------------------------------------------------------------------------------------

class State extends Schema.Class<State>("EventStream/State")({
  lastOffset: Offset,
}) {
  static initial = new State({ lastOffset: Offset.make("-1") });
}

const reduce = (_state: State, event: Event): State => new State({ lastOffset: event.offset });

const formatOffset = (n: number): Offset => Offset.make(n.toString().padStart(16, "0"));

const offsetToNumber = (offset: Offset): number => parseInt(offset, 10);

// -------------------------------------------------------------------------------------
// EventStream interface
// -------------------------------------------------------------------------------------

export interface EventStream {
  /** Subscribe to live events on this path, optionally starting after an offset */
  readonly subscribe: (options?: { from?: Offset }) => Stream.Stream<Event>;

  /** Read historical events on this path, optionally within a range */
  readonly read: (options?: { from?: Offset; to?: Offset }) => Stream.Stream<Event>;

  /** Append an event to this path, returns the stored event with assigned offset */
  readonly append: (event: EventInput) => Effect.Effect<Event>;
}

// -------------------------------------------------------------------------------------
// EventStream implementation
// -------------------------------------------------------------------------------------

/**
 * Create an EventStream from a path-scoped StreamStorage.
 *
 * Mirrors the Processor pattern: State class, reduce function, boot from history.
 * Key difference: Processors react to events via their subscribe loop, but
 * EventStream can't subscribe to itself (circular). Instead, EventStream reacts
 * to events in `append` - after storage.write, we update state and publish.
 *
 * The `subscribe` method here is the inverse - it's "respond to a subscriber",
 * not "subscribe to something". Like Cloudflare Workers' `fetch` handler.
 */
export const make = (storage: StreamStorage, path: StreamPath): Effect.Effect<EventStream> =>
  Effect.gen(function* () {
    // Boot: hydrate offset from history
    let state = yield* storage.read().pipe(Stream.runFold(State.initial, reduce));

    const pubsub = yield* PubSub.unbounded<Event>();

    const append = (eventInput: EventInput) =>
      Effect.gen(function* () {
        const nextOffset = formatOffset(offsetToNumber(state.lastOffset) + 1);
        const createdAt = yield* DateTime.now;
        const event = Event.make({ ...eventInput, path, offset: nextOffset, createdAt });

        yield* storage.append(event);
        state = reduce(state, event);
        yield* PubSub.publish(pubsub, event);
        return event;
      });

    const subscribe = (options?: { from?: Offset }) =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          let lastOffset = options?.from ?? Offset.make("-1");

          // Subscribe to PubSub first (don't miss events during history replay)
          const queue = yield* PubSub.subscribe(pubsub);
          const liveStream = Stream.fromQueue(queue);

          // Track last historical offset, then filter live to only new events
          const trackedHistorical = storage
            .read({ from: lastOffset })
            .pipe(Stream.tap((event) => Effect.sync(() => (lastOffset = event.offset))));

          const dedupedLive = liveStream.pipe(
            Stream.dropWhile((event) => Offset.lte(event.offset, lastOffset)),
          );

          return Stream.concat(trackedHistorical, dedupedLive);
        }),
      ).pipe(Stream.catchAllCause(() => Stream.empty));

    const read = (options?: { from?: Offset; to?: Offset }) =>
      storage.read(options).pipe(Stream.catchAllCause(() => Stream.empty));

    return { append, subscribe, read };
  });
