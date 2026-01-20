/**
 * Durable Stream Manager - Event streaming with replay support
 *
 * Stores event history and supports:
 *   - Full replay for late subscribers
 *   - Offset-based subscription
 *   - Pluggable storage backends via StreamStorageService
 */

import { Chunk, Context, Effect, Layer, PubSub, Stream } from "effect";

import { Event, Offset, Payload, StreamPath } from "./domain.js";
import { InMemoryLayer as InMemoryStreamStorage } from "./services/stream-storage/InMemory.js";
import { StreamStorage, StreamStorageService } from "./services/stream-storage/index.js";

// Re-export types for convenience
export { Event, Offset, Payload, StreamPath, StreamStorageService };
export type { StreamStorage };

// -------------------------------------------------------------------------------------
// DurableIterateStream - single stream with history and replay
// -------------------------------------------------------------------------------------

export interface DurableIterateStream {
  readonly append: (input: { payload: Payload }) => Effect.Effect<void>;
  /** Subscribe with optional offset. live=false (default) for historical only, live=true for live only */
  readonly subscribe: (options?: { from?: Offset; live?: boolean }) => Stream.Stream<Event>;
}

export const DurableIterateStream = {
  make: (input: {
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
    }),
};

// -------------------------------------------------------------------------------------
// DurableStreamManager - multi-stream service
// -------------------------------------------------------------------------------------

export class DurableStreamManager extends Context.Tag("@app/DurableStreamManager")<
  DurableStreamManager,
  {
    readonly append: (input: { path: StreamPath; payload: Payload }) => Effect.Effect<void>;
    readonly subscribe: (input: {
      path: StreamPath;
      from?: Offset;
      live?: boolean;
    }) => Stream.Stream<Event>;
  }
>() {}

const DurableStreamManagerLive: Layer.Layer<DurableStreamManager, never, StreamStorageService> =
  Layer.effect(
    DurableStreamManager,
    Effect.gen(function* () {
      const storage = yield* StreamStorageService;
      const streams = new Map<StreamPath, DurableIterateStream>();

      const getOrCreateStream = Effect.fn(function* (path: StreamPath) {
        const existing = streams.get(path);
        if (existing) {
          return existing;
        }
        const stream = yield* DurableIterateStream.make({ storage, path });
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

      const subscribe = ({
        path,
        from,
        live,
      }: {
        path: StreamPath;
        from?: Offset;
        live?: boolean;
      }) =>
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

export const InMemoryDurableStreamManager: Layer.Layer<DurableStreamManager> =
  DurableStreamManagerLive.pipe(Layer.provide(InMemoryStreamStorage));

// -------------------------------------------------------------------------------------
// In-source tests
// -------------------------------------------------------------------------------------

if (import.meta.vitest) {
  const { it, expect, describe } = await import("@effect/vitest");

  describe("DurableStreamManager", () => {
    it.effect("late subscriber receives historical events", () =>
      Effect.gen(function* () {
        const manager = yield* DurableStreamManager;
        const path = StreamPath.make("test/durable");

        // Append events before subscribing
        yield* manager.append({ path: path, payload: { message: "first" } });
        yield* manager.append({ path: path, payload: { message: "second" } });

        // Late subscriber should get history
        const events = yield* manager
          .subscribe({ path: path })
          .pipe(Stream.take(2), Stream.runCollect);

        const arr = Chunk.toReadonlyArray(events);
        expect(arr).toHaveLength(2);
        expect(arr[0].offset).toBe("0000000000000000");
        expect(arr[0].payload).toEqual({ message: "first" });
        expect(arr[1].offset).toBe("0000000000000001");
        expect(arr[1].payload).toEqual({ message: "second" });
      }).pipe(Effect.provide(InMemoryDurableStreamManager)),
    );

    it.effect("subscribe with from skips earlier events", () =>
      Effect.gen(function* () {
        const manager = yield* DurableStreamManager;
        const path = StreamPath.make("test/offset");

        // Append 3 events
        yield* manager.append({ path: path, payload: { idx: 0 } });
        yield* manager.append({ path: path, payload: { idx: 1 } });
        yield* manager.append({ path: path, payload: { idx: 2 } });

        // Subscribe from offset 1 (skip offset 0)
        const events = yield* manager
          .subscribe({ path: path, from: Offset.make("0000000000000001") })
          .pipe(Stream.take(2), Stream.runCollect);

        const arr = Chunk.toReadonlyArray(events);
        expect(arr.map((e) => e.offset)).toEqual(["0000000000000001", "0000000000000002"]);
        expect(arr.map((e) => e.payload)).toEqual([{ idx: 1 }, { idx: 2 }]);
      }).pipe(Effect.provide(InMemoryDurableStreamManager)),
    );

    it.effect("historical subscribe does not receive later events", () =>
      Effect.gen(function* () {
        const manager = yield* DurableStreamManager;
        const path = StreamPath.make("test/historical-only");

        // Append historical event
        yield* manager.append({ path: path, payload: { type: "historical" } });

        // Historical subscriber should complete after existing events
        const events = yield* manager.subscribe({ path: path }).pipe(Stream.runCollect);

        const arr = Chunk.toReadonlyArray(events);
        expect(arr).toHaveLength(1);
        expect(arr[0].payload).toEqual({ type: "historical" });
      }).pipe(Effect.provide(InMemoryDurableStreamManager)),
    );

    it.live("subscribe with live=true receives only live events", () =>
      Effect.gen(function* () {
        const manager = yield* DurableStreamManager;
        const path = StreamPath.make("test/live-only");

        // Append historical event
        yield* manager.append({ path: path, payload: { type: "historical" } });

        // Subscribe with live=true (live only)
        const subscriber = yield* manager
          .subscribe({ path: path, live: true })
          .pipe(Stream.take(1), Stream.runCollect, Effect.fork);

        yield* Effect.sleep("1 millis");

        // Append live event
        yield* manager.append({ path: path, payload: { type: "live" } });

        const events = yield* subscriber;
        const arr = Chunk.toReadonlyArray(events);

        // Should only have the live event, not historical
        expect(arr).toHaveLength(1);
        expect(arr[0].offset).toBe("0000000000000001");
        expect(arr[0].payload).toEqual({ type: "live" });
      }).pipe(Effect.provide(InMemoryDurableStreamManager)),
    );
  });
}
