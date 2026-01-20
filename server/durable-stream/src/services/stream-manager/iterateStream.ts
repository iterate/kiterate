/**
 * IterateStream - single stream with history and replay
 */
import { Effect, PubSub, Ref, Stream } from "effect";

import { Event, EventInput, Offset, StreamPath } from "../../domain.js";
import { StreamStorage, StreamStorageError } from "../stream-storage/service.js";

// -------------------------------------------------------------------------------------
// IterateStream interface
// -------------------------------------------------------------------------------------

export interface IterateStream {
  readonly append: (input: { event: EventInput }) => Effect.Effect<void, StreamStorageError>;
  /**
   * Subscribe to events on this stream.
   * @param from - Last seen offset (exclusive). Returns events with offset > from.
   * @param live - If true, continues with live events after history. Default: false (history only).
   */
  readonly subscribe: (options?: {
    from?: Offset;
    live?: boolean;
  }) => Stream.Stream<Event, StreamStorageError>;
}

// -------------------------------------------------------------------------------------
// IterateStream implementation
// -------------------------------------------------------------------------------------

export const make = (input: {
  storage: StreamStorage;
  path: StreamPath;
}): Effect.Effect<IterateStream> =>
  Effect.gen(function* () {
    const { storage, path } = input;
    const pubsub = yield* PubSub.unbounded<Event>();

    const append = ({ event: eventInput }: { event: EventInput }) =>
      Effect.gen(function* () {
        const event = yield* storage.append({ path, event: eventInput });
        yield* PubSub.publish(pubsub, event);
      });

    const subscribe = (options?: { from?: Offset; live?: boolean }) =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          const from = options?.from ?? Offset.make("-1");
          const live = options?.live ?? false;

          if (!live) {
            // Historical only - no PubSub subscription
            return storage.read({ path, from });
          }

          // Live mode: history + live with deduplication
          // Subscribe to PubSub first (don't miss events during history replay)
          const queue = yield* PubSub.subscribe(pubsub);
          const liveStream = Stream.fromQueue(queue);

          const historicalStream = storage.read({ path, from });
          const lastOffsetRef = yield* Ref.make<Offset>(from);

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
