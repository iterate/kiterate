/**
 * EventStream - single stream with history and replay
 */
import { Effect, PubSub, Ref, Stream } from "effect";

import { Event, EventInput, Offset } from "../../domain.js";
import { StreamStorage } from "../stream-storage/service.js";

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
 * Wraps storage with PubSub for live event subscriptions.
 */
export const make = (storage: StreamStorage): Effect.Effect<EventStream> =>
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<Event>();

    const append = (eventInput: EventInput) =>
      Effect.gen(function* () {
        const event = yield* storage.append(eventInput);
        yield* PubSub.publish(pubsub, event);
        return event;
      });

    const subscribe = (options?: { from?: Offset }) =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          const from = options?.from ?? Offset.make("-1");

          // Subscribe to PubSub first (don't miss events during history replay)
          const queue = yield* PubSub.subscribe(pubsub);
          const liveStream = Stream.fromQueue(queue);

          const historicalStream = storage.read({ from });
          const lastOffsetRef = yield* Ref.make<Offset>(from);

          // Track last historical offset, then filter live to only new events
          const trackedHistorical = historicalStream.pipe(
            Stream.tap((event) => Ref.set(lastOffsetRef, event.offset)),
          );

          const dedupedLive = liveStream.pipe(
            Stream.filterEffect((event) =>
              Ref.modify(lastOffsetRef, (lastOffset) => {
                if (Offset.gt(event.offset, lastOffset)) {
                  const result: readonly [boolean, Offset] = [true, event.offset];
                  return result;
                }
                const result: readonly [boolean, Offset] = [false, lastOffset];
                return result;
              }),
            ),
          );

          return Stream.concat(trackedHistorical, dedupedLive);
        }),
      ).pipe(Stream.catchAllCause(() => Stream.empty));

    const read = (options?: { from?: Offset; to?: Offset }) =>
      storage.read(options).pipe(Stream.catchAllCause(() => Stream.empty));

    return { append, subscribe, read };
  });
