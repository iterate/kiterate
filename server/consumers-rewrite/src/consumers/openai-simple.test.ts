import { Response } from "@effect/ai";
import { it, expect } from "@effect/vitest";
import { Effect, Fiber } from "effect";

import { EventInput, EventType, StreamPath } from "../domain.js";
import { TestLanguageModel, makeTestSimpleStream } from "../testing/index.js";
import { OpenAiSimpleConsumer } from "./openai-simple.js";

type StreamPart = Response.StreamPart<{}>;

// -------------------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------------------

it.scoped("triggers LLM on user message when enabled", () =>
  Effect.gen(function* () {
    const lm = yield* TestLanguageModel;
    const stream = yield* makeTestSimpleStream(StreamPath.make("test"));

    // Enable openai model
    yield* stream.appendEvent(
      EventInput.make({
        type: EventType.make("iterate:agent:config:set"),
        payload: { model: "openai" },
      }),
    );

    // Fork the consumer
    yield* OpenAiSimpleConsumer.run(stream).pipe(Effect.forkScoped);

    // Wait for consumer to be ready
    yield* stream.waitForSubscribe();

    // Send a user message
    yield* stream.appendEvent(
      EventInput.make({
        type: EventType.make("iterate:agent:action:send-user-message:called"),
        payload: { content: "Hello!" },
      }),
    );

    // Wait for LLM to be called
    yield* lm.waitForCall();

    // Emit a response and complete
    yield* lm.emit({
      type: "text-delta",
      delta: "Hi!",
      id: "msg1",
      metadata: {},
    } as StreamPart);
    yield* lm.complete();

    // Wait for request-ended event (replaces yieldNow loops)
    yield* stream.waitForEventType(EventType.make("iterate:openai:request-ended"));

    // Verify events
    const events = yield* stream.getEvents();
    const eventTypes = events.map((e) => e.type);

    expect(eventTypes).toContain("iterate:agent:config:set");
    expect(eventTypes).toContain("iterate:agent:action:send-user-message:called");
    expect(eventTypes).toContain("iterate:openai:request-started");
    expect(eventTypes).toContain("iterate:openai:response:sse");
    expect(eventTypes).toContain("iterate:openai:request-ended");
  }).pipe(Effect.provide(TestLanguageModel.layer)),
);

it.scoped("interrupts in-flight request when new user message arrives", () =>
  Effect.gen(function* () {
    const lm = yield* TestLanguageModel;
    const stream = yield* makeTestSimpleStream(StreamPath.make("test"));

    // Enable openai model
    yield* stream.appendEvent(
      EventInput.make({
        type: EventType.make("iterate:agent:config:set"),
        payload: { model: "openai" },
      }),
    );

    // Fork the consumer
    yield* OpenAiSimpleConsumer.run(stream).pipe(Effect.forkScoped);
    yield* stream.waitForSubscribe();

    // Send first user message
    yield* stream.appendEvent(
      EventInput.make({
        type: EventType.make("iterate:agent:action:send-user-message:called"),
        payload: { content: "First message" },
      }),
    );

    // Wait for first LLM call
    yield* lm.waitForCall();

    // Emit a couple of deltas but DON'T complete
    yield* lm.emit({
      type: "text-delta",
      delta: "Starting to ",
      id: "msg1",
      metadata: {},
    } as StreamPart);
    yield* lm.emit({
      type: "text-delta",
      delta: "respond...",
      id: "msg1",
      metadata: {},
    } as StreamPart);

    // Send second user message while first is still streaming
    yield* stream.appendEvent(
      EventInput.make({
        type: EventType.make("iterate:agent:action:send-user-message:called"),
        payload: { content: "Second message (interrupts first)" },
      }),
    );

    // Wait for second LLM call (means first was interrupted)
    yield* lm.waitForCall();

    // Complete the second request
    yield* lm.emit({
      type: "text-delta",
      delta: "Response to second!",
      id: "msg2",
      metadata: {},
    } as StreamPart);
    yield* lm.complete();

    // Wait for the second request to end
    yield* stream.waitForEventType(EventType.make("iterate:openai:request-ended"));

    // Verify events
    const events = yield* stream.getEvents();
    const eventTypes = events.map((e) => e.type);

    // Should have two request-started events
    const requestStartedCount = eventTypes.filter(
      (t) => t === "iterate:openai:request-started",
    ).length;
    expect(requestStartedCount).toBe(2);

    // Should have an interrupted event for the first request
    expect(eventTypes).toContain("iterate:openai:request-interrupted");

    // Should have a cancelled event (from the fiber interruption)
    expect(eventTypes).toContain("iterate:openai:request-cancelled");

    // Should have exactly one request-ended (for the second request)
    const requestEndedCount = eventTypes.filter((t) => t === "iterate:openai:request-ended").length;
    expect(requestEndedCount).toBe(1);
  }).pipe(Effect.provide(TestLanguageModel.layer)),
);
