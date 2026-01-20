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

export const Payload = Schema.Record({ key: Schema.String, value: Schema.Unknown });
export type Payload = typeof Payload.Type;

export class Event extends Schema.Class<Event>("Event")({
  seq: Schema.Number,
  payload: Payload,
}) {}

// -------------------------------------------------------------------------------------
// StreamStorage - pluggable storage backend
// -------------------------------------------------------------------------------------

export interface StreamStorage {
  /** Append payload to stream, assign seq, store, and return the event */
  readonly append: (streamPath: StreamPath, payload: Payload) => Effect.Effect<Event>;
  /** Read events from stream as a stream, optionally starting from a seq */
  readonly readFrom: (streamPath: StreamPath, fromSeq?: number) => Stream.Stream<Event>;
  /** Get the current sequence number for stream (next event will have this seq) */
  readonly currentSeq: (streamPath: StreamPath) => Effect.Effect<number>;
}

export class StreamStorageService extends Context.Tag("@app/StreamStorageService")<
  StreamStorageService,
  StreamStorage
>() {
  static InMemory: Layer.Layer<StreamStorageService> = Layer.sync(StreamStorageService, () => {
    const streams = new Map<StreamPath, { events: Event[]; seq: number }>();

    const getOrCreateStream = (path: StreamPath) => {
      let stream = streams.get(path);
      if (!stream) {
        stream = { events: [], seq: 0 };
        streams.set(path, stream);
      }
      return stream;
    };

    return {
      append: (streamPath, payload) =>
        Effect.sync(() => {
          const stream = getOrCreateStream(streamPath);
          const event = Event.make({ seq: stream.seq++, payload });
          stream.events.push(event);
          return event;
        }),
      readFrom: (streamPath, fromSeq) =>
        Stream.suspend(() => {
          const stream = getOrCreateStream(streamPath);
          const events =
            fromSeq !== undefined ? stream.events.filter((e) => e.seq >= fromSeq) : stream.events;
          return Stream.fromIterable(events);
        }),
      currentSeq: (streamPath) =>
        Effect.sync(() => {
          const stream = getOrCreateStream(streamPath);
          return stream.seq;
        }),
    };
  });
}

// -------------------------------------------------------------------------------------
// DurableIterateStream - single stream with history and replay
// -------------------------------------------------------------------------------------

export interface DurableIterateStream {
  readonly append: (payload: Payload) => Effect.Effect<void>;
  /** Subscribe with optional offset. fromSeq=-1 for live only, undefined for full replay */
  readonly subscribe: (options?: { fromSeq?: number }) => Stream.Stream<Event>;
}

export const DurableIterateStream = {
  make: (storage: StreamStorage, streamPath: StreamPath): Effect.Effect<DurableIterateStream> =>
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<Event>();

      const append = (payload: Payload) =>
        Effect.gen(function* () {
          const event = yield* storage.append(streamPath, payload);
          yield* PubSub.publish(pubsub, event);
        });

      const subscribe = (options?: { fromSeq?: number }) =>
        Stream.unwrapScoped(
          Effect.gen(function* () {
            const fromSeq = options?.fromSeq;

            // Subscribe to live first (don't miss events during replay)
            const queue = yield* PubSub.subscribe(pubsub);
            const liveStream = Stream.fromQueue(queue);

            // Live only mode
            if (fromSeq === -1) {
              return liveStream;
            }

            // Track current seq to deduplicate overlap between history and live
            const currentSeq = yield* storage.currentSeq(streamPath);

            // Get historical events as stream
            const historyStream = storage.readFrom(streamPath, fromSeq);

            return Stream.concat(
              historyStream,
              Stream.filter(liveStream, (e) => e.seq >= currentSeq),
            );
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
    readonly append: (input: { streamPath: StreamPath; payload: Payload }) => Effect.Effect<void>;
    readonly subscribe: (input: {
      streamPath: StreamPath;
      fromSeq?: number;
    }) => Stream.Stream<Event>;
  }
>() {}

const DurableStreamManagerLive: Layer.Layer<DurableStreamManager, never, StreamStorageService> =
  Layer.effect(
    DurableStreamManager,
    Effect.gen(function* () {
      const storage = yield* StreamStorageService;
      const streams = new Map<StreamPath, DurableIterateStream>();

      const getOrCreateStream = Effect.fn(function* (streamPath: StreamPath) {
        const existing = streams.get(streamPath);
        if (existing) {
          return existing;
        }
        const stream = yield* DurableIterateStream.make(storage, streamPath);
        streams.set(streamPath, stream);
        return stream;
      });

      const append = Effect.fn("DurableStreamManager.append")(function* ({
        streamPath,
        payload,
      }: {
        streamPath: StreamPath;
        payload: Payload;
      }) {
        const stream = yield* getOrCreateStream(streamPath);
        yield* stream.append(payload);
      });

      const subscribe = ({ streamPath, fromSeq }: { streamPath: StreamPath; fromSeq?: number }) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const stream = yield* getOrCreateStream(streamPath);
            return stream.subscribe(fromSeq !== undefined ? { fromSeq } : undefined);
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
        yield* manager.append({ streamPath: path, payload: { message: "first" } });
        yield* manager.append({ streamPath: path, payload: { message: "second" } });

        // Late subscriber should get history
        const events = yield* manager
          .subscribe({ streamPath: path })
          .pipe(Stream.take(2), Stream.runCollect);

        const arr = Chunk.toReadonlyArray(events);
        expect(arr).toHaveLength(2);
        expect(arr[0].seq).toBe(0);
        expect(arr[0].payload).toEqual({ message: "first" });
        expect(arr[1].seq).toBe(1);
        expect(arr[1].payload).toEqual({ message: "second" });
      }).pipe(Effect.provide(InMemoryDurableStreamManager)),
    );

    it.effect("subscribe with fromSeq skips earlier events", () =>
      Effect.gen(function* () {
        const manager = yield* DurableStreamManager;
        const path = StreamPath.make("test/offset");

        // Append 3 events
        yield* manager.append({ streamPath: path, payload: { idx: 0 } });
        yield* manager.append({ streamPath: path, payload: { idx: 1 } });
        yield* manager.append({ streamPath: path, payload: { idx: 2 } });

        // Subscribe from seq 1 (skip seq 0)
        const events = yield* manager
          .subscribe({ streamPath: path, fromSeq: 1 })
          .pipe(Stream.take(2), Stream.runCollect);

        const arr = Chunk.toReadonlyArray(events);
        expect(arr.map((e) => e.seq)).toEqual([1, 2]);
        expect(arr.map((e) => e.payload)).toEqual([{ idx: 1 }, { idx: 2 }]);
      }).pipe(Effect.provide(InMemoryDurableStreamManager)),
    );

    it.live("receives both historical and live events", () =>
      Effect.gen(function* () {
        const manager = yield* DurableStreamManager;
        const path = StreamPath.make("test/hybrid");

        // Append historical event
        yield* manager.append({ streamPath: path, payload: { type: "historical" } });

        // Start subscriber (will get historical + wait for live)
        const subscriber = yield* manager
          .subscribe({ streamPath: path })
          .pipe(Stream.take(2), Stream.runCollect, Effect.fork);

        // Give subscriber time to set up
        yield* Effect.sleep("1 millis");

        // Append live event
        yield* manager.append({ streamPath: path, payload: { type: "live" } });

        const events = yield* subscriber;
        const arr = Chunk.toReadonlyArray(events);
        expect(arr.map((e) => e.payload)).toEqual([{ type: "historical" }, { type: "live" }]);
      }).pipe(Effect.provide(InMemoryDurableStreamManager)),
    );

    it.live("subscribe with fromSeq=-1 receives only live events", () =>
      Effect.gen(function* () {
        const manager = yield* DurableStreamManager;
        const path = StreamPath.make("test/live-only");

        // Append historical event
        yield* manager.append({ streamPath: path, payload: { type: "historical" } });

        // Subscribe with -1 (live only)
        const subscriber = yield* manager
          .subscribe({ streamPath: path, fromSeq: -1 })
          .pipe(Stream.take(1), Stream.runCollect, Effect.fork);

        yield* Effect.sleep("1 millis");

        // Append live event
        yield* manager.append({ streamPath: path, payload: { type: "live" } });

        const events = yield* subscriber;
        const arr = Chunk.toReadonlyArray(events);

        // Should only have the live event, not historical
        expect(arr).toHaveLength(1);
        expect(arr[0].seq).toBe(1);
        expect(arr[0].payload).toEqual({ type: "live" });
      }).pipe(Effect.provide(InMemoryDurableStreamManager)),
    );
  });
}
