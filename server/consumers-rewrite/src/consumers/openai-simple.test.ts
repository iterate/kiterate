import { LanguageModel, Response } from "@effect/ai";
import { it, expect } from "@effect/vitest";
import { DateTime, Deferred, Effect, Fiber, Layer, Queue, Stream } from "effect";

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
  // Mutable state - using let since we're in a closure
  let callCount = 0;
  const callWaiters: Deferred.Deferred<void>[] = [];
  let currentQueue: Queue.Queue<StreamPart> | null = null;
  let currentCompletion: Deferred.Deferred<void> | null = null;

  const control: MockLanguageModelControl = {
    emit: (part) => (currentQueue ? Queue.offer(currentQueue, part) : Effect.void),
    complete: () => (currentCompletion ? Deferred.succeed(currentCompletion, void 0) : Effect.void),
    fail: (_error) =>
      currentCompletion ? Deferred.succeed(currentCompletion, void 0) : Effect.void, // TODO: proper stream failure
    waitForCall: () =>
      Effect.gen(function* () {
        // If we've already had more calls than waiters, return immediately
        if (callCount > callWaiters.length) return;
        // Otherwise create a waiter for the next call
        const deferred = yield* Deferred.make<void>();
        callWaiters.push(deferred);
        yield* Deferred.await(deferred);
      }),
  };

  const lm: LanguageModel.Service = {
    streamText: () =>
      Effect.gen(function* () {
        // Set up fresh queue and completion for this call
        const queue = yield* Queue.unbounded<StreamPart>();
        const completion = yield* Deferred.make<void>();
        currentQueue = queue;
        currentCompletion = completion;

        // Increment call count and notify waiters
        callCount++;
        const waiter = callWaiters[callCount - 1];
        if (waiter) yield* Deferred.succeed(waiter, void 0);

        return Stream.fromQueue(queue).pipe(
          Stream.interruptWhen(Deferred.await(completion)),
          Stream.onDone(() => Queue.shutdown(queue)),
        );
      }).pipe(Stream.unwrap),
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
  readonly waitForEventType: (type: EventType) => Effect.Effect<Event>;
}

export const makeMockSimpleStream = (path: StreamPath) =>
  Effect.gen(function* () {
    const events: Event[] = [];
    const subscribers = yield* Queue.unbounded<Event>();
    const subscribed = yield* Deferred.make<void>();
    const waiters = new Map<string, Deferred.Deferred<Event>>();
    let nextOffset = 0;

    const makeEvent = (input: EventInput): Event =>
      Event.make({
        ...input,
        path,
        offset: Offset.make(String(nextOffset++).padStart(16, "0")),
        createdAt: DateTime.unsafeNow(),
      });

    const notifyWaiters = (event: Event) =>
      Effect.gen(function* () {
        const deferred = waiters.get(event.type);
        if (deferred) {
          yield* Deferred.succeed(deferred, event);
          waiters.delete(event.type);
        }
      });

    const control: MockSimpleStreamControl = {
      append: (input) =>
        Effect.gen(function* () {
          const event = makeEvent(input);
          events.push(event);
          yield* Queue.offer(subscribers, event);
          yield* notifyWaiters(event);
          return event;
        }),
      getEvents: () => Effect.sync(() => events),
      waitForSubscribe: () => Deferred.await(subscribed),
      waitForEventType: (type) =>
        Effect.gen(function* () {
          // Check if event already exists
          const existing = events.find((e) => e.type === type);
          if (existing) return existing;

          // Create a deferred to wait for this event type
          const deferred = yield* Deferred.make<Event>();
          waiters.set(type, deferred);
          return yield* Deferred.await(deferred);
        }),
    };

    const stream: SimpleStream = {
      path,

      read: (options) => {
        const snapshot = [...events];
        return Stream.fromIterable(snapshot).pipe(
          Stream.filter((e) => (options?.from ? Offset.gt(e.offset, options.from) : true)),
        );
      },

      subscribe: (options) =>
        Effect.gen(function* () {
          const snapshot = [...events];
          yield* Deferred.succeed(subscribed, void 0);
          return Stream.fromIterable(snapshot).pipe(
            Stream.filter((e) => (options?.from ? Offset.gt(e.offset, options.from) : true)),
            Stream.concat(
              Stream.fromQueue(subscribers).pipe(
                Stream.filter((e) => (options?.from ? Offset.gt(e.offset, options.from) : true)),
              ),
            ),
          );
        }).pipe(Stream.unwrap),

      append: (input) =>
        Effect.gen(function* () {
          const event = makeEvent(input);
          events.push(event);
          yield* Queue.offer(subscribers, event);
          yield* notifyWaiters(event);
          return event.offset;
        }),
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

    // Wait for request-ended event (replaces yieldNow loops)
    yield* streamControl.waitForEventType(EventType.make("iterate:openai:request-ended"));

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
