import { LanguageModel, Response } from "@effect/ai";
import { it, expect } from "@effect/vitest";
import { DateTime, Deferred, Effect, Exit, Fiber, Layer, Queue, Stream } from "effect";

import { Event, EventInput, EventType, Offset, StreamPath } from "../domain.js";
import { SimpleStream } from "./simple-consumer.js";
import { OpenAiSimpleConsumer } from "./openai-simple.js";

// -------------------------------------------------------------------------------------
// Mock LanguageModel
// -------------------------------------------------------------------------------------

type StreamPart = Response.StreamPart<{}>;

interface MockLanguageModelControl {
  readonly emit: (part: StreamPart) => Effect.Effect<void>;
  readonly complete: () => Effect.Effect<void>;
  readonly fail: (error: Error) => Effect.Effect<void>;
  readonly waitForCall: () => Effect.Effect<void>;
}

export const makeMockLanguageModel = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<StreamPart | null | Error>();
  const called = yield* Deferred.make<void>();

  const control: MockLanguageModelControl = {
    emit: (part) => Queue.offer(queue, part),
    complete: () => Queue.offer(queue, null),
    fail: (error) => Queue.offer(queue, error),
    waitForCall: () => Deferred.await(called),
  };

  const lm: LanguageModel.Service = {
    streamText: () => {
      Deferred.unsafeDone(called, Exit.void);
      return Stream.fromQueue(queue).pipe(
        Stream.takeWhile((item): item is StreamPart => item !== null && !(item instanceof Error)),
      );
    },
    generateText: () => Effect.die("not implemented"),
    generateObject: () => Effect.die("not implemented"),
  };

  const layer = Layer.succeed(LanguageModel.LanguageModel, lm);

  return { control, layer };
});

// -------------------------------------------------------------------------------------
// Mock SimpleStream
// -------------------------------------------------------------------------------------

interface MockSimpleStreamControl {
  readonly append: (event: EventInput) => Effect.Effect<Event>;
  readonly getEvents: () => Effect.Effect<readonly Event[]>;
  readonly waitForSubscribe: () => Effect.Effect<void>;
}

export const makeMockSimpleStream = (path: StreamPath) =>
  Effect.gen(function* () {
    const events: Event[] = [];
    const subscribers = yield* Queue.unbounded<Event>();
    const subscribed = yield* Deferred.make<void>();
    let nextOffset = 0;

    const makeEvent = (input: EventInput): Event =>
      Event.make({
        ...input,
        path,
        offset: Offset.make(String(nextOffset++).padStart(16, "0")),
        createdAt: DateTime.unsafeNow(),
      });

    const control: MockSimpleStreamControl = {
      append: (input) =>
        Effect.sync(() => {
          const event = makeEvent(input);
          events.push(event);
          return event;
        }).pipe(Effect.tap((event) => Queue.offer(subscribers, event))),
      getEvents: () => Effect.sync(() => events),
      waitForSubscribe: () => Deferred.await(subscribed),
    };

    const stream: SimpleStream = {
      path,

      read: (options) => {
        const snapshot = [...events];
        return Stream.fromIterable(snapshot).pipe(
          Stream.filter((e) => (options?.from ? Offset.gt(e.offset, options.from) : true)),
        );
      },

      subscribe: (options) => {
        const snapshot = [...events];
        Deferred.unsafeDone(subscribed, Exit.void);
        return Stream.fromIterable(snapshot).pipe(
          Stream.filter((e) => (options?.from ? Offset.gt(e.offset, options.from) : true)),
          Stream.concat(
            Stream.fromQueue(subscribers).pipe(
              Stream.filter((e) => (options?.from ? Offset.gt(e.offset, options.from) : true)),
            ),
          ),
        );
      },

      append: (input) =>
        Effect.sync(() => {
          const event = makeEvent(input);
          events.push(event);
          return event.offset;
        }).pipe(Effect.tap(() => Queue.offer(subscribers, events.at(-1)!))),
    };

    return { stream, control };
  });

// -------------------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------------------

it.scoped("triggers LLM on user message when enabled", () =>
  Effect.gen(function* () {
    const { control: lmControl, layer: lmLayer } = yield* makeMockLanguageModel;
    const { stream, control: streamControl } = yield* makeMockSimpleStream(StreamPath.make("test"));

    // Enable openai model
    yield* streamControl.append(
      EventInput.make({
        type: EventType.make("iterate:agent:config:set"),
        payload: { model: "openai" },
      }),
    );

    // Fork the consumer
    const fiber = yield* OpenAiSimpleConsumer.run(stream).pipe(
      Effect.provide(lmLayer),
      Effect.fork,
    );

    // Wait for consumer to be ready
    yield* streamControl.waitForSubscribe();

    // Send a user message
    yield* streamControl.append(
      EventInput.make({
        type: EventType.make("iterate:agent:action:send-user-message:called"),
        payload: { content: "Hello!" },
      }),
    );

    // Wait for LLM to be called
    yield* lmControl.waitForCall();

    // Emit a response and complete
    yield* lmControl.emit({
      type: "text-delta",
      delta: "Hi!",
      id: "msg1",
      metadata: {},
    } as StreamPart);
    yield* lmControl.complete();

    // Let the consumer finish processing
    for (let i = 0; i < 10; i++) yield* Effect.yieldNow();

    // Verify events
    const events = yield* streamControl.getEvents();
    const eventTypes = events.map((e) => e.type);

    expect(eventTypes).toContain("iterate:agent:config:set");
    expect(eventTypes).toContain("iterate:agent:action:send-user-message:called");
    expect(eventTypes).toContain("iterate:openai:request-started");
    expect(eventTypes).toContain("iterate:openai:response:sse");
    expect(eventTypes).toContain("iterate:openai:request-ended");

    yield* Fiber.interrupt(fiber);
  }),
);
