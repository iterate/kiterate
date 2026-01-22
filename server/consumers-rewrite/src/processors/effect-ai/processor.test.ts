import { Response } from "@effect/ai";
import { it, expect } from "@effect/vitest";
import { Effect } from "effect";

import { StreamPath } from "../../domain.js";
import { ConfigSetEvent, UserMessageEvent } from "../../events.js";
import { TestLanguageModel, makeTestSimpleStream } from "../../testing/index.js";
import {
  RequestCancelledEvent,
  RequestEndedEvent,
  RequestInterruptedEvent,
  RequestStartedEvent,
  ResponseSseEvent,
} from "./events.js";
import { EffectAiProcessor } from "./processor.js";

// -------------------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------------------

it.scoped("triggers LLM on user message when enabled", () =>
  Effect.gen(function* () {
    const lm = yield* TestLanguageModel;
    const stream = yield* makeTestSimpleStream(StreamPath.make("test"));

    // Setup
    yield* stream.appendEvent(ConfigSetEvent.make({ model: "openai" }));
    yield* EffectAiProcessor.run(stream).pipe(Effect.forkScoped);
    yield* stream.waitForSubscribe();

    // Send a user message
    yield* stream.appendEvent(UserMessageEvent.make({ content: "Hello!" }));
    yield* lm.waitForCall();

    // Request starts
    const request = yield* stream.waitForEvent(RequestStartedEvent);

    // Emit response and complete
    yield* lm.emit(Response.textDeltaPart({ id: "msg1", delta: "Hi!" }));
    yield* lm.complete();

    // SSE event should reference the request
    const sse = yield* stream.waitForEvent(ResponseSseEvent);
    expect(sse.payload.requestOffset).toBe(request.offset);

    // Request ended should reference the request
    const ended = yield* stream.waitForEvent(RequestEndedEvent);
    expect(ended.payload.requestOffset).toBe(request.offset);
  }).pipe(Effect.provide(TestLanguageModel.layer)),
);

it.scoped("interrupts in-flight request when new user message arrives", () =>
  Effect.gen(function* () {
    const lm = yield* TestLanguageModel;
    const stream = yield* makeTestSimpleStream(StreamPath.make("test"));

    // Setup
    yield* stream.appendEvent(ConfigSetEvent.make({ model: "openai" }));
    yield* EffectAiProcessor.run(stream).pipe(Effect.forkScoped);
    yield* stream.waitForSubscribe();

    // Send first user message
    yield* stream.appendEvent(UserMessageEvent.make({ content: "First message" }));
    yield* lm.waitForCall();

    // First request starts
    const firstRequest = yield* stream.waitForEvent(RequestStartedEvent);

    // Emit deltas for first request (don't complete)
    yield* lm.emit(Response.textDeltaPart({ id: "msg1", delta: "Starting to " }));
    yield* lm.emit(Response.textDeltaPart({ id: "msg1", delta: "respond..." }));

    // Wait for SSE events - they should reference the first request
    const sse1 = yield* stream.waitForEvent(ResponseSseEvent);
    const sse2 = yield* stream.waitForEvent(ResponseSseEvent);
    expect(sse1.payload.requestOffset).toBe(firstRequest.offset);
    expect(sse2.payload.requestOffset).toBe(firstRequest.offset);

    // Send second user message - this triggers interruption
    yield* stream.appendEvent(
      UserMessageEvent.make({ content: "Second message (interrupts first)" }),
    );

    // Second request starts (consumes from queue, so this is the NEW one)
    const secondRequest = yield* stream.waitForEvent(RequestStartedEvent);
    yield* lm.waitForCall();

    // Interrupted event should reference first request
    const interrupted = yield* stream.waitForEvent(RequestInterruptedEvent);
    expect(interrupted.payload.requestOffset).toBe(firstRequest.offset);

    // Cancelled event should reference first request
    const cancelled = yield* stream.waitForEvent(RequestCancelledEvent);
    expect(cancelled.payload.requestOffset).toBe(firstRequest.offset);
    expect(cancelled.payload.reason).toBe("interrupted");

    // Complete second request
    yield* lm.emit(Response.textDeltaPart({ id: "msg2", delta: "Response to second!" }));
    yield* lm.complete();

    // SSE from second request should reference it
    const sse3 = yield* stream.waitForEvent(ResponseSseEvent);
    expect(sse3.payload.requestOffset).toBe(secondRequest.offset);

    // Request ended should reference second request
    const ended = yield* stream.waitForEvent(RequestEndedEvent);
    expect(ended.payload.requestOffset).toBe(secondRequest.offset);
  }).pipe(Effect.provide(TestLanguageModel.layer)),
);
