import { Response } from "@effect/ai";
import { describe, it, expect } from "@effect/vitest";
import { Duration, Effect, TestClock } from "effect";

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
import { LlmLoopProcessor, llmDebounce } from "./processor.js";

// -------------------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------------------

describe("LlmLoopProcessor", () => {
  it.scoped("triggers LLM on user message when enabled", () =>
    Effect.gen(function* () {
      const lm = yield* TestLanguageModel;
      const stream = yield* makeTestSimpleStream(StreamPath.make("test"));

      // Setup
      yield* stream.append(ConfigSetEvent.make({ model: "openai" }));
      yield* LlmLoopProcessor.run(stream).pipe(Effect.forkScoped);
      yield* stream.waitForSubscribe();

      // Send a user message
      yield* stream.append(UserMessageEvent.make({ content: "Hello!" }));
      yield* Effect.yieldNow();
      yield* TestClock.adjust(llmDebounce.duration);
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
      yield* stream.append(ConfigSetEvent.make({ model: "openai" }));
      yield* LlmLoopProcessor.run(stream).pipe(Effect.forkScoped);
      yield* stream.waitForSubscribe();

      // Send first user message
      yield* stream.append(UserMessageEvent.make({ content: "First message" }));
      yield* Effect.yieldNow();
      yield* TestClock.adjust(llmDebounce.duration);
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
      yield* stream.append(UserMessageEvent.make({ content: "Second message (interrupts first)" }));
      yield* Effect.yieldNow();
      yield* TestClock.adjust(llmDebounce.duration);

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

  it.scoped("debounces rapid messages into a single request", () =>
    Effect.gen(function* () {
      const lm = yield* TestLanguageModel;
      const stream = yield* makeTestSimpleStream(StreamPath.make("test"));

      // Setup
      yield* stream.append(ConfigSetEvent.make({ model: "openai" }));
      yield* LlmLoopProcessor.run(stream).pipe(Effect.forkScoped);
      yield* stream.waitForSubscribe();

      // Rapid user messages
      yield* stream.append(UserMessageEvent.make({ content: "One" }));
      yield* stream.append(UserMessageEvent.make({ content: "Two" }));
      yield* stream.append(UserMessageEvent.make({ content: "Three" }));
      yield* Effect.yieldNow();

      const before = yield* stream.getEvents();
      expect(before.filter(RequestStartedEvent.is)).toHaveLength(0);

      yield* TestClock.adjust(llmDebounce.duration);
      yield* lm.waitForCall();

      const request = yield* stream.waitForEvent(RequestStartedEvent);
      yield* lm.complete();
      yield* stream.waitForEvent(RequestEndedEvent);

      const after = yield* stream.getEvents();
      const started = after.filter(RequestStartedEvent.is);
      expect(started).toHaveLength(1);
      expect(started[0]?.offset).toBe(request.offset);
    }).pipe(Effect.provide(TestLanguageModel.layer)),
  );

  it.scoped("executes within maxWait under continuous triggers", () =>
    Effect.gen(function* () {
      const lm = yield* TestLanguageModel;
      const stream = yield* makeTestSimpleStream(StreamPath.make("test"));

      // Setup
      yield* stream.append(ConfigSetEvent.make({ model: "openai" }));
      yield* LlmLoopProcessor.run(stream).pipe(Effect.forkScoped);
      yield* stream.waitForSubscribe();

      const interval = Duration.millis(150);
      for (let i = 0; i < 13; i++) {
        yield* stream.append(UserMessageEvent.make({ content: `Message ${i}` }));
        yield* Effect.yieldNow();
        yield* TestClock.adjust(interval);
      }

      const beforeMaxWait = yield* stream.getEvents();
      expect(beforeMaxWait.filter(RequestStartedEvent.is)).toHaveLength(0);

      yield* TestClock.adjust(Duration.millis(50));
      yield* lm.waitForCall();

      const request = yield* stream.waitForEvent(RequestStartedEvent);
      yield* lm.complete();
      yield* stream.waitForEvent(RequestEndedEvent);

      const started = (yield* stream.getEvents()).filter(RequestStartedEvent.is);
      expect(started).toHaveLength(1);
      expect(started[0]?.offset).toBe(request.offset);
    }).pipe(Effect.provide(TestLanguageModel.layer)),
  );
});
