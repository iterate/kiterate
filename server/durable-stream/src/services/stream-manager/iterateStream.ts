/**
 * IterateStream - single stream with history and replay
 */
import { Effect, PubSub, Stream } from "effect";

import { Event, Offset, Payload, StreamPath } from "../../domain.js";
import { StreamStorage, StreamStorageError } from "../stream-storage/service.js";

// -------------------------------------------------------------------------------------
// IterateStream interface
// -------------------------------------------------------------------------------------

export interface IterateStream {
  readonly append: (input: { payload: Payload }) => Effect.Effect<void, StreamStorageError>;
  /** Subscribe with optional offset. live=false (default) for historical only, live=true for live only */
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

    const append = ({ payload }: { payload: Payload }) =>
      Effect.gen(function* () {
        const event = yield* storage.append({ path, payload });
        yield* PubSub.publish(pubsub, event);
      });

    const subscribe = (options?: { from?: Offset; live?: boolean }) =>
      Stream.unwrapScoped(
        Effect.gen(function* () {
          const from = options?.from ?? Offset.make("-1");
          const live = options?.live ?? false;

          // Live only mode
          if (live) {
            const queue = yield* PubSub.subscribe(pubsub);
            return Stream.fromQueue(queue);
          }

          // Historical only (default)
          return storage.read({ path, from });
        }),
      );

    return { append, subscribe };
  });
