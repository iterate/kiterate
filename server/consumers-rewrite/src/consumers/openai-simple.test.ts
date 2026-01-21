import { LanguageModel, Response } from "@effect/ai";
import { it, expect } from "@effect/vitest";
import { DateTime, Deferred, Effect, Fiber, Layer, Queue, Stream } from "effect";

import { Event, EventInput, EventType, Offset, StreamPath } from "../domain.js";
import { SimpleStream } from "./simple-consumer.js";

// -------------------------------------------------------------------------------------
// Mock LanguageModel
// -------------------------------------------------------------------------------------

type StreamPart = Response.StreamPart<{}>;

interface MockLanguageModelControl {
  /** Emit a stream part to the current streamText call */
  readonly emit: (part: StreamPart) => Effect.Effect<void>;
  /** Complete the stream successfully */
  readonly complete: () => Effect.Effect<void>;
  /** Fail the stream */
  readonly fail: (error: Error) => Effect.Effect<void>;
  /** Wait for streamText to be called */
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
      Deferred.unsafeDone(called, void 0 as never);
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
  /** Append an event externally (simulates external writes) */
  readonly append: (event: EventInput) => Effect.Effect<Event>;
  /** Get all appended events */
  readonly getEvents: () => Effect.Effect<readonly Event[]>;
}

export const makeMockSimpleStream = (path: StreamPath) =>
  Effect.gen(function* () {
    const events: Event[] = [];
    const subscribers = yield* Queue.unbounded<Event>();
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
    };

    const stream: SimpleStream = {
      path,

      read: (options) =>
        Stream.fromIterable(events).pipe(
          Stream.filter((e) => (options?.from ? Offset.gt(e.offset, options.from) : true)),
        ),

      subscribe: (options) =>
        Stream.fromIterable(events).pipe(
          Stream.filter((e) => (options?.from ? Offset.gt(e.offset, options.from) : true)),
          Stream.concat(Stream.fromQueue(subscribers)),
        ),

      append: (input) =>
        Effect.sync(() => {
          const event = makeEvent(input);
          events.push(event);
          return event.offset;
        }).pipe(Effect.tap(() => Queue.offer(subscribers, events.at(-1)!))),
    };

    return { stream, control };
  });

import { OpenAiSimpleConsumer } from "./openai-simple.js";

// -------------------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------------------

it.scoped("triggers LLM on user message when enabled", () =>
  Effect.gen(function* () {
    const { control: lmControl, layer: lmLayer } = yield* makeMockLanguageModel;
    const { stream, control: streamControl } = yield* makeMockSimpleStream(StreamPath.make("test"));

    // Set up: enable openai model
    yield* streamControl.append(
      EventInput.make({
        type: EventType.make("iterate:agent:config:set"),
        payload: { model: "openai" },
      }),
    );

    // Fork the consumer (runs in background)
    const fiber = yield* OpenAiSimpleConsumer.run(stream).pipe(
      Effect.provide(lmLayer),
      Effect.fork,
    );

    // Send a user message
    yield* streamControl.append(
      EventInput.make({
        type: EventType.make("iterate:agent:action:send-user-message:called"),
        payload: { content: "Hello!" },
      }),
    );

    // Wait for LLM to be called
    yield* lmControl.waitForCall();

    // Emit a text delta
    yield* lmControl.emit({
      type: "text-delta",
      delta: "Hi there!",
      id: "msg1",
      metadata: {},
    } as StreamPart);

    // Complete the stream
    yield* lmControl.complete();

    // Give it a moment to process
    yield* Effect.sleep("50 millis");

    // Check what events were appended
    const events = yield* streamControl.getEvents();
    const eventTypes = events.map((e) => e.type);

    console.log("Event types:", eventTypes);

    // Should have: config, user-message, request-started, response:sse, request-ended
    expect(eventTypes).toContain("iterate:agent:config:set");
    expect(eventTypes).toContain("iterate:agent:action:send-user-message:called");
    expect(eventTypes).toContain("iterate:openai:request-started");
    expect(eventTypes).toContain("iterate:openai:response:sse");
    expect(eventTypes).toContain("iterate:openai:request-ended");

    // Clean up
    yield* Fiber.interrupt(fiber);
  }),
);
