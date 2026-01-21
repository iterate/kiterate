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
