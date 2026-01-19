import { Effect, Schema, Context, Stream, Layer, PubSub, Chunk } from "effect";

const Event = Schema.Record({ key: Schema.String, value: Schema.Unknown }).pipe(
  Schema.brand("Event"),
);
type Event = typeof Event.Type;

export class NonDurableStream extends Context.Tag("@app/NonDurableStream")<
  NonDurableStream,
  {
    // TODO: Needs to retun the Event
    readonly append: (event: Event) => Effect.Effect<void>;
    readonly stream: () => Stream.Stream<Event>;
  }
>() {}

export const InMemoryNonDurableStream: Layer.Layer<NonDurableStream> =
  Layer.effect(
    NonDurableStream,
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<Event>();

      return {
        append: (event) => PubSub.publish(pubsub, event).pipe(Effect.asVoid),
        stream: () =>
          Stream.unwrapScoped(
            Effect.map(PubSub.subscribe(pubsub), (queue) =>
              Stream.fromQueue(queue),
            ),
          ),
      };
    }),
  );

// In-source tests
if (import.meta.vitest) {
  const { it, expect, describe } = import.meta.vitest;

  describe("NonDurableStream", () => {
    it("subscriber receives events from append", async () => {
      const program = Effect.gen(function* () {
        const stream = yield* NonDurableStream;

        const subscriber = yield* stream
          .stream()
          .pipe(Stream.take(1), Stream.runCollect, Effect.fork);

        yield* Effect.sleep("1 millis");

        const event = Event.make({ message: "hello" });
        yield* stream.append(event);

        const events = yield* subscriber;

        expect(Chunk.toReadonlyArray(events)).toEqual([event]);
      }).pipe(Effect.provide(InMemoryNonDurableStream));

      await Effect.runPromise(program);
    });

    it("multiple subscribers receive the same event", async () => {
      const program = Effect.gen(function* () {
        const stream = yield* NonDurableStream;

        const subscriber1 = yield* stream
          .stream()
          .pipe(Stream.take(1), Stream.runCollect, Effect.fork);
        const subscriber2 = yield* stream
          .stream()
          .pipe(Stream.take(1), Stream.runCollect, Effect.fork);
        const subscriber3 = yield* stream
          .stream()
          .pipe(Stream.take(1), Stream.runCollect, Effect.fork);

        yield* Effect.sleep("1 millis");

        const event = Event.make({ message: "hello" });
        yield* stream.append(event);

        const [events1, events2, events3] = yield* Effect.all([
          subscriber1,
          subscriber2,
          subscriber3,
        ]);

        expect(Chunk.toReadonlyArray(events1)).toEqual([event]);
        expect(Chunk.toReadonlyArray(events2)).toEqual([event]);
        expect(Chunk.toReadonlyArray(events3)).toEqual([event]);
      }).pipe(Effect.provide(InMemoryNonDurableStream));

      await Effect.runPromise(program);
    });

    it("late subscriber misses events appended before subscribing", async () => {
      const program = Effect.gen(function* () {
        const stream = yield* NonDurableStream;

        const event = Event.make({ message: "hello" });
        yield* stream.append(event);

        yield* Effect.sleep("1 millis");

        // Subscribe AFTER the event was appended
        const events = yield* stream.stream().pipe(
          Stream.takeUntil(() => true), // take nothing, just check
          Stream.timeout("50 millis"),
          Stream.runCollect,
          Effect.catchTag("TimeoutException", () =>
            Effect.succeed(Chunk.empty<Event>()),
          ),
        );

        expect(Chunk.toReadonlyArray(events)).toEqual([]);
      }).pipe(Effect.provide(InMemoryNonDurableStream));

      await Effect.runPromise(program);
    });

    it("multiple streams are independent", async () => {
      const program = Effect.gen(function* () {
        const streamA = yield* NonDurableStream;
        const streamB = yield* NonDurableStream;

        const subscriberA = yield* streamA
          .stream()
          .pipe(Stream.take(1), Stream.runCollect, Effect.fork);
        const subscriberB = yield* streamB
          .stream()
          .pipe(Stream.take(1), Stream.runCollect, Effect.fork);

        yield* Effect.sleep("1 millis");

        const eventA = Event.make({ source: "A" });
        const eventB = Event.make({ source: "B" });
        yield* streamA.append(eventA);
        yield* streamB.append(eventB);

        const [eventsA, eventsB] = yield* Effect.all([
          subscriberA,
          subscriberB,
        ]);

        expect(Chunk.toReadonlyArray(eventsA)).toEqual([eventA]);
        expect(Chunk.toReadonlyArray(eventsB)).toEqual([eventB]);
      }).pipe(Effect.provide(InMemoryNonDurableStream));

      await Effect.runPromise(program);
    });
  });
}
