/**
 * Voice note context:
 *
 * Yeah, okay, so the only thing we now have to do is check in on the agent
 * that we asked to make a durable streams-ish API to agent manager, and then
 * you have to just point the CLI or the Shitterate web client at this web
 * server. The only, I think there's one teeny tiny wrinkle, which is, I think,
 * the HTTP path that I dictated to the AI to implement here in your wrapper
 * server doesn't start with slash agents, whereas the CLI and the web UI
 * expect slash agents and then agent path. So you might have to change your
 * wrapper ever so slightly.
 *
 * Okay, and so you want this to actually integrate into the PI wrapping stuff.
 * It shouldn't just be appending knowledge. She doesn't know about it. That's
 * like the PI wrapping stuff is like entirely implemented just as a as like a.
 * Actually, no, like ignore the pi wrapping stuff. Like there's a CLI that
 * just if you just look at the CLI, it just lets you append and then the web
 * UI if you don't prefix with slash pi, it literally just shows you the events
 * that there are, and when a new one comes in, it renders it also. And then
 * you could have, like, you should be able to put like the left side of the
 * screen and right side of the screen, two stream subscribers, use the CLI to
 * post something in it, see it show up. We make a little chat app with our
 * durable shit. Exactly. Because we have that, we can literally, with like a
 * tiny bit of wrapping, implement a shitty LLM agent. Okay. so. yeah
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
