import { Response } from "@effect/ai";
import { it, expect } from "@effect/vitest";
import { Effect } from "effect";

import { Event, StreamPath } from "../domain.js";
import {
  ConfigSetEvent,
  UserMessageEvent,
  RequestStartedEvent,
  ResponseSseEvent,
  RequestEndedEvent,
  RequestInterruptedEvent,
  RequestCancelledEvent,
} from "../events.js";
import { TestLanguageModel, makeTestSimpleStream } from "../testing/index.js";
import { OpenAiSimpleConsumer } from "./openai-simple.js";

// -------------------------------------------------------------------------------------
// Test Helpers
// -------------------------------------------------------------------------------------

/** Find all events matching a schema */
const findEvents = <P>(
  events: readonly Event[],
  schema: { is: (e: Event) => e is Event & { payload: P } },
) => events.filter(schema.is);

/** Find first event matching a schema */
const findEvent = <P>(
  events: readonly Event[],
  schema: { is: (e: Event) => e is Event & { payload: P } },
) => events.find(schema.is);

// -------------------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------------------

it.scoped("triggers LLM on user message when enabled", () =>
  Effect.gen(function* () {
    const lm = yield* TestLanguageModel;
    const stream = yield* makeTestSimpleStream(StreamPath.make("test"));

    // Enable openai model
    yield* stream.appendEvent(ConfigSetEvent.make({ model: "openai" }));

    // Fork the consumer
    yield* OpenAiSimpleConsumer.run(stream).pipe(Effect.forkScoped);

    // Wait for consumer to be ready
    yield* stream.waitForSubscribe();

    // Send a user message
    yield* stream.appendEvent(UserMessageEvent.make({ content: "Hello!" }));

    // Wait for LLM to be called
    yield* lm.waitForCall();

    // Emit a response and complete
    yield* lm.emit(Response.textDeltaPart({ id: "msg1", delta: "Hi!" }));
    yield* lm.complete();

    // Wait for request-ended event
    yield* stream.waitForEvent(RequestEndedEvent);

    const events = yield* stream.getEvents();

    // Verify event sequence
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toEqual([
      ConfigSetEvent.typeString,
      UserMessageEvent.typeString,
      RequestStartedEvent.typeString,
      ResponseSseEvent.typeString,
      RequestEndedEvent.typeString,
    ]);

    // Verify requestOffset consistency - SSE and ended events reference the started event
    const requestStarted = findEvent(events, RequestStartedEvent);
    const responseSse = findEvent(events, ResponseSseEvent);
    const requestEnded = findEvent(events, RequestEndedEvent);

    expect(requestStarted).toBeDefined();
    expect(responseSse).toBeDefined();
    expect(requestEnded).toBeDefined();

    const requestOffset = requestStarted!.offset;
    expect(responseSse!.payload.requestOffset).toBe(requestOffset);
    expect(requestEnded!.payload.requestOffset).toBe(requestOffset);
  }).pipe(Effect.provide(TestLanguageModel.layer)),
);

it.scoped("interrupts in-flight request when new user message arrives", () =>
  Effect.gen(function* () {
    const lm = yield* TestLanguageModel;
    const stream = yield* makeTestSimpleStream(StreamPath.make("test"));

    // Enable openai model
    yield* stream.appendEvent(ConfigSetEvent.make({ model: "openai" }));

    // Fork the consumer
    yield* OpenAiSimpleConsumer.run(stream).pipe(Effect.forkScoped);
    yield* stream.waitForSubscribe();

    // Send first user message
    yield* stream.appendEvent(UserMessageEvent.make({ content: "First message" }));

    // Wait for first LLM call
    yield* lm.waitForCall();

    // Emit a couple of deltas but DON'T complete
    yield* lm.emit(Response.textDeltaPart({ id: "msg1", delta: "Starting to " }));
    yield* lm.emit(Response.textDeltaPart({ id: "msg1", delta: "respond..." }));

    // Wait for the 2 SSE events to be processed before interrupting
    yield* stream.waitForEventCount(ResponseSseEvent, 2);

    // Send second user message while first is still streaming
    yield* stream.appendEvent(
      UserMessageEvent.make({ content: "Second message (interrupts first)" }),
    );

    // Wait for second LLM call (means first was interrupted)
    yield* lm.waitForCall();

    // Complete the second request
    yield* lm.emit(Response.textDeltaPart({ id: "msg2", delta: "Response to second!" }));
    yield* lm.complete();

    // Wait for the second request to end
    yield* stream.waitForEvent(RequestEndedEvent);

    const events = yield* stream.getEvents();

    // Find key events
    const requestsStarted = findEvents(events, RequestStartedEvent);
    const responsesSse = findEvents(events, ResponseSseEvent);
    const requestInterrupted = findEvent(events, RequestInterruptedEvent);
    const requestCancelled = findEvent(events, RequestCancelledEvent);
    const requestEnded = findEvent(events, RequestEndedEvent);

    // Should have exactly two request-started events
    expect(requestsStarted).toHaveLength(2);
    const [firstRequest, secondRequest] = requestsStarted;

    // Should have three SSE events (2 from first request, 1 from second)
    expect(responsesSse).toHaveLength(3);

    // First two SSE events should reference the first request's offset
    expect(responsesSse[0].payload.requestOffset).toBe(firstRequest.offset);
    expect(responsesSse[1].payload.requestOffset).toBe(firstRequest.offset);

    // Third SSE event should reference the second request's offset
    expect(responsesSse[2].payload.requestOffset).toBe(secondRequest.offset);

    // Interrupted event should reference the first request's offset
    expect(requestInterrupted).toBeDefined();
    expect(requestInterrupted!.payload.requestOffset).toBe(firstRequest.offset);

    // Cancelled event should reference the first request's offset
    expect(requestCancelled).toBeDefined();
    expect(requestCancelled!.payload.requestOffset).toBe(firstRequest.offset);
    expect(requestCancelled!.payload.reason).toBe("interrupted");

    // Ended event should reference the second request's offset
    expect(requestEnded).toBeDefined();
    expect(requestEnded!.payload.requestOffset).toBe(secondRequest.offset);
  }).pipe(Effect.provide(TestLanguageModel.layer)),
);
