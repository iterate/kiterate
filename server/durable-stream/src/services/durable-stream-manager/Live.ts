/**
 * Live implementation of DurableStreamManager
 */
import { Effect, Layer, PubSub, Stream } from "effect";

import { Event, Offset, Payload, StreamPath } from "../../domain.js";
import { InMemoryLayer as InMemoryStreamStorage } from "../stream-storage/InMemory.js";
import { StreamStorage, StreamStorageService } from "../stream-storage/index.js";
import { DurableIterateStream, DurableStreamManager } from "./index.js";

// -------------------------------------------------------------------------------------
// DurableIterateStream implementation
// -------------------------------------------------------------------------------------

export const makeDurableIterateStream = (input: {
  storage: StreamStorage;
  path: StreamPath;
}): Effect.Effect<DurableIterateStream> =>
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

// -------------------------------------------------------------------------------------
// DurableStreamManager layer
// -------------------------------------------------------------------------------------

export const DurableStreamManagerLive: Layer.Layer<
  DurableStreamManager,
  never,
  StreamStorageService
> = Layer.effect(
  DurableStreamManager,
  Effect.gen(function* () {
    const storage = yield* StreamStorageService;
    const streams = new Map<StreamPath, DurableIterateStream>();

    const getOrCreateStream = Effect.fn(function* (path: StreamPath) {
      const existing = streams.get(path);
      if (existing) {
        return existing;
      }
      const stream = yield* makeDurableIterateStream({ storage, path });
      streams.set(path, stream);
      return stream;
    });

    const append = Effect.fn("DurableStreamManager.append")(function* ({
      path,
      payload,
    }: {
      path: StreamPath;
      payload: Payload;
    }) {
      const stream = yield* getOrCreateStream(path);
      yield* stream.append({ payload });
    });

    const subscribe = ({ path, from, live }: { path: StreamPath; from?: Offset; live?: boolean }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const stream = yield* getOrCreateStream(path);
          return stream.subscribe({
            ...(from !== undefined && { from }),
            ...(live !== undefined && { live }),
          });
        }).pipe(Effect.withSpan("DurableStreamManager.subscribe")),
      );

    return { append, subscribe };
  }),
);

// -------------------------------------------------------------------------------------
// Convenience layers
// -------------------------------------------------------------------------------------

export const InMemoryDurableStreamManager: Layer.Layer<DurableStreamManager> =
  DurableStreamManagerLive.pipe(Layer.provide(InMemoryStreamStorage));
