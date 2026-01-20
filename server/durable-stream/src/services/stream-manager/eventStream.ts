/**
 * EventStream - single stream with history and replay
 */
import { Effect, PubSub, Ref, Stream } from "effect";

import { Event, EventInput, Offset, StreamPath } from "../../domain.js";
import { StreamStorage, StreamStorageError } from "../stream-storage/service.js";

// -------------------------------------------------------------------------------------
// EventStream interface
// -------------------------------------------------------------------------------------

export interface EventStream {
  readonly append: (input: { event: EventInput }) => Effect.Effect<void, StreamStorageError>;
  /**
   * Subscribe to events on this stream.
   * @param after - Last seen offset (exclusive). Returns events with offset > after.
   * @param live - If true, continues with live events after history. Default: false (history only).
   */
  readonly subscribe: (options?: {
    after?: Offset;
    live?: boolean;
  }) => Stream.Stream<Event, StreamStorageError>;
}

// -------------------------------------------------------------------------------------
// EventStream implementation
// -------------------------------------------------------------------------------------

export const make = (input: {
  storage: StreamStorage;
  path: StreamPath;
}): Effect.Effect<EventStream> =>
  Effect.gen(function* () {
    const { storage, path } = input;
    const pubsub = yield* PubSub.unbounded<Event>();

    const append = ({ event: eventInput }: { event: EventInput }) =>
      Effect.gen(function* () {
        const event = yield* storage.append({ path, event: eventInput });
        yield* PubSub.publish(pubsub, event);
      });

    const subscribe = (options?: { after?: Offset; live?: boolean }) =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          const after = options?.after ?? Offset.make("-1");
          const live = options?.live ?? false;

          if (!live) {
            // Historical only - no PubSub subscription
            return storage.read({ path, after });
          }

          // Live mode: history + live with deduplication
          // Subscribe to PubSub first (don't miss events during history replay)
          const queue = yield* PubSub.subscribe(pubsub);
          const liveStream = Stream.fromQueue(queue);

          const historicalStream = storage.read({ path, after });
          const lastOffsetRef = yield* Ref.make<Offset>(after);

          // Track last historical offset, then filter live to only new events
          const trackedHistorical = historicalStream.pipe(
            Stream.tap((event) => Ref.set(lastOffsetRef, event.offset)),
          );

          const dedupedLive = liveStream.pipe(
            Stream.filterEffect((event) =>
              Ref.get(lastOffsetRef).pipe(Effect.map((lastOffset) => event.offset > lastOffset)),
            ),
          );

          return Stream.concat(trackedHistorical, dedupedLive);
        }),
      );

    return { append, subscribe };
  });
