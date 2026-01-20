/**
 * Durable Streams - Effect-native event streaming infrastructure
 *
 * Goal: Build a foundation for real-time event streaming that can power LLM agents.
 *
 * Architecture:
 *   - StreamManager: manages multiple named streams (by path)
 *   - IterateStream: single stream with append/subscribe
 *   - HTTP layer: POST /agents/:path to append, GET /agents/:path for SSE
 *
 * Current status:
 *   - [x] In-memory pub/sub working
 *   - [ ] Persistence (late subscribers miss events currently)
 *   - [ ] Replay from offset
 *   - [ ] Wire to HTTP server with /agents prefix
 *
 * Usage vision:
 *   - CLI appends events to a stream
 *   - Multiple web clients subscribe via SSE
 *   - Events show up in real-time across all subscribers
 *   - Wrap an LLM agent on top: prompt in, streaming tokens out
 */

import { Effect, Schema, Context, Stream, Layer, PubSub, Chunk } from "effect";

export const Event = Schema.Record({ key: Schema.String, value: Schema.Unknown }).pipe(
  Schema.brand("Event"),
);
export type Event = typeof Event.Type;

export const StreamPath = Schema.String.pipe(Schema.brand("StreamPath"));
export type StreamPath = typeof StreamPath.Type;

// -------------------------------------------------------------------------------------
// IterateStream - an effectful data type for pub/sub streaming
// -------------------------------------------------------------------------------------

export interface IterateStream {
  readonly append: (event: Event) => Effect.Effect<void>;
  readonly subscribe: () => Stream.Stream<Event>;
}

export const IterateStream = {
  makeInMemory: (): Effect.Effect<IterateStream> =>
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<Event>();

      return {
        append: (event) => PubSub.publish(pubsub, event).pipe(Effect.asVoid),
        subscribe: () =>
          Stream.unwrapScoped(
            Effect.map(PubSub.subscribe(pubsub), (queue) =>
              Stream.fromQueue(queue),
            ),
          ),
      };
    }),
};

// -------------------------------------------------------------------------------------
// IterateStreamFactory - service for creating IterateStreams
// -------------------------------------------------------------------------------------

export class IterateStreamFactory extends Context.Tag(
  "@app/IterateStreamFactory",
)<
  IterateStreamFactory,
  {
    readonly make: () => Effect.Effect<IterateStream>;
  }
>() {}

export const InMemoryIterateStreamFactory: Layer.Layer<IterateStreamFactory> =
  Layer.succeed(IterateStreamFactory, {
    make: () => IterateStream.makeInMemory(),
  });

export class StreamManager extends Context.Tag("@app/StreamManager")<
  StreamManager,
  {
    readonly append: (input: {
      streamPath: StreamPath;
      event: Event;
    }) => Effect.Effect<void>;
    readonly subscribe: (input: {
      streamPath: StreamPath;
    }) => Stream.Stream<Event>;
  }
>() {}

export const StreamManagerLive: Layer.Layer<
  StreamManager,
  never,
  IterateStreamFactory
> = Layer.effect(
  StreamManager,
  Effect.gen(function* () {
    const factory = yield* IterateStreamFactory;
    const streams = new Map<StreamPath, IterateStream>();

    const getOrCreateStream = Effect.fn(function* (streamPath: StreamPath) {
      const existing = streams.get(streamPath);
      if (existing) {
        return existing;
      }
      const stream = yield* factory.make();
      streams.set(streamPath, stream);
      return stream;
    });

    const append = Effect.fn("StreamManager.append")(function* ({
      streamPath,
      event,
    }: {
      streamPath: StreamPath;
      event: Event;
    }) {
      const stream = yield* getOrCreateStream(streamPath);
      yield* stream.append(event);
    });

    const subscribe = ({ streamPath }: { streamPath: StreamPath }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const stream = yield* getOrCreateStream(streamPath);
          return stream.subscribe();
        }).pipe(Effect.withSpan("StreamManager.subscribe")),
      );

    return { append, subscribe };
  }),
);

export const InMemoryStreamManager: Layer.Layer<StreamManager> =
  StreamManagerLive.pipe(Layer.provide(InMemoryIterateStreamFactory));

// In-source tests
if (import.meta.vitest) {
  const { it, expect, describe } = import.meta.vitest;

  describe("StreamManager", () => {
    it("subscriber receives events from append on same path", async () => {
      const program = Effect.gen(function* () {
        const manager = yield* StreamManager;
        const path = StreamPath.make("test/stream");

        const subscriber = yield* manager
          .subscribe({ streamPath: path })
          .pipe(Stream.take(1), Stream.runCollect, Effect.fork);

        yield* Effect.sleep("1 millis");

        const event = Event.make({ message: "hello" });
        yield* manager.append({ streamPath: path, event });

        const events = yield* subscriber;

        expect(Chunk.toReadonlyArray(events)).toEqual([event]);
      }).pipe(Effect.provide(InMemoryStreamManager));

      await Effect.runPromise(program);
    });

    it("different paths are independent", async () => {
      const program = Effect.gen(function* () {
        const manager = yield* StreamManager;
        const pathA = StreamPath.make("stream/a");
        const pathB = StreamPath.make("stream/b");

        const subscriberA = yield* manager
          .subscribe({ streamPath: pathA })
          .pipe(Stream.take(1), Stream.runCollect, Effect.fork);
        const subscriberB = yield* manager
          .subscribe({ streamPath: pathB })
          .pipe(Stream.take(1), Stream.runCollect, Effect.fork);

        yield* Effect.sleep("1 millis");

        const eventA = Event.make({ source: "A" });
        const eventB = Event.make({ source: "B" });
        yield* manager.append({ streamPath: pathA, event: eventA });
        yield* manager.append({ streamPath: pathB, event: eventB });

        const [eventsA, eventsB] = yield* Effect.all([
          subscriberA,
          subscriberB,
        ]);

        expect(Chunk.toReadonlyArray(eventsA)).toEqual([eventA]);
        expect(Chunk.toReadonlyArray(eventsB)).toEqual([eventB]);
      }).pipe(Effect.provide(InMemoryStreamManager));

      await Effect.runPromise(program);
    });

    it("multiple subscribers on same path receive same event", async () => {
      const program = Effect.gen(function* () {
        const manager = yield* StreamManager;
        const path = StreamPath.make("shared/stream");

        const subscriber1 = yield* manager
          .subscribe({ streamPath: path })
          .pipe(Stream.take(1), Stream.runCollect, Effect.fork);
        const subscriber2 = yield* manager
          .subscribe({ streamPath: path })
          .pipe(Stream.take(1), Stream.runCollect, Effect.fork);

        yield* Effect.sleep("1 millis");

        const event = Event.make({ message: "broadcast" });
        yield* manager.append({ streamPath: path, event });

        const [events1, events2] = yield* Effect.all([
          subscriber1,
          subscriber2,
        ]);

        expect(Chunk.toReadonlyArray(events1)).toEqual([event]);
        expect(Chunk.toReadonlyArray(events2)).toEqual([event]);
      }).pipe(Effect.provide(InMemoryStreamManager));

      await Effect.runPromise(program);
    });

    it("late subscriber misses events", async () => {
      const program = Effect.gen(function* () {
        const manager = yield* StreamManager;
        const path = StreamPath.make("test/late");

        const event = Event.make({ message: "early" });
        yield* manager.append({ streamPath: path, event });

        yield* Effect.sleep("1 millis");

        const events = yield* manager.subscribe({ streamPath: path }).pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.timeoutTo({
            duration: "50 millis",
            onSuccess: (chunk) => chunk,
            onTimeout: () => Chunk.empty<Event>(),
          }),
        );

        expect(Chunk.toReadonlyArray(events)).toEqual([]);
      }).pipe(Effect.provide(InMemoryStreamManager));

      await Effect.runPromise(program);
    });
  });
}
