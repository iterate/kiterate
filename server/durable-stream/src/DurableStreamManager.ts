/**
 * Durable Stream Manager - Event streaming with replay support
 *
 * Unlike StreamManager which only supports live subscribers, DurableStreamManager
 * stores event history and supports:
 *   - Full replay for late subscribers
 *   - Offset-based subscription (fromSeq)
 *
 * Current implementation uses in-memory storage. Can be extended with
 * persistent backends (file, database) via DurableStorage abstraction.
 */

import { Effect, Schema, Context, Stream, Layer, PubSub, Chunk } from "effect";

// -------------------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------------------

export const StreamPath = Schema.String.pipe(Schema.brand("StreamPath"));
export type StreamPath = typeof StreamPath.Type;

export const Offset = Schema.String.pipe(Schema.brand("Offset"));
export type Offset = typeof Offset.Type;

export const Payload = Schema.Record({ key: Schema.String, value: Schema.Unknown });
export type Payload = typeof Payload.Type;

export class Event extends Schema.Class<Event>("Event")({
  offset: Offset,
  payload: Payload,
}) {}

// -------------------------------------------------------------------------------------
// StreamStorage - pluggable storage backend
// -------------------------------------------------------------------------------------

export interface StreamStorage {
  /** Append payload to stream, assign offset, store, and return the event */
  readonly append: (input: { path: StreamPath; payload: Payload }) => Effect.Effect<Event>;
  /** Read events from stream as a stream, optionally starting from an offset */
  readonly read: (input: { path: StreamPath; from?: Offset }) => Stream.Stream<Event>;
}

export class StreamStorageService extends Context.Tag("@app/StreamStorageService")<
  StreamStorageService,
  StreamStorage
>() {
  static InMemory: Layer.Layer<StreamStorageService> = Layer.sync(StreamStorageService, () => {
    const streams = new Map<StreamPath, { events: Event[]; nextOffset: number }>();

    const getOrCreateStream = (path: StreamPath) => {
      let stream = streams.get(path);
      if (!stream) {
        stream = { events: [], nextOffset: 0 };
        streams.set(path, stream);
      }
      return stream;
    };

    const formatOffset = (n: number): Offset => Offset.make(n.toString().padStart(16, "0"));

    return {
      append: ({ path, payload }) =>
        Effect.sync(() => {
          const stream = getOrCreateStream(path);
          const offset = formatOffset(stream.nextOffset++);
          const event = Event.make({ offset, payload });
          stream.events.push(event);
          return event;
        }),
      read: ({ path, from }) =>
        Stream.suspend(() => {
          const stream = getOrCreateStream(path);
          const events =
            from !== undefined ? stream.events.filter((e) => e.offset >= from) : stream.events;
          return Stream.fromIterable(events);
        }),
    };
  });
}

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
  DurableStreamManagerLive.pipe(Layer.provide(StreamStorageService.InMemory));

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
