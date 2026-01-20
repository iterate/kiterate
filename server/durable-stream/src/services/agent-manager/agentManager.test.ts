/**
 * AgentManager tests
 */
import { LanguageModel, Response } from "@effect/ai";
import { describe, expect, it } from "@effect/vitest";
import { Chunk, Effect, Layer, Stream } from "effect";

import { EventInput, EventType, StreamPath } from "../../domain.js";
import { liveLayer as streamManagerLiveLayer } from "../stream-manager/live.js";
import * as StreamStorage from "../stream-storage/index.js";
import { AgentManager, liveLayer } from "./index.js";

// -------------------------------------------------------------------------------------
// Mock LanguageModel for testing
// -------------------------------------------------------------------------------------

// Mock stream parts matching the new API (StreamPartEncoded)
const mockStreamParts: Array<Response.StreamPartEncoded> = [
  { type: "text-delta", id: "1", delta: "Hello " },
  { type: "text-delta", id: "2", delta: "from mock!" },
  { type: "finish", reason: "stop", usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 } },
];

// Use LanguageModel.make to create a properly typed mock
const mockLanguageModel = LanguageModel.make({
  generateText: () => Effect.succeed([{ type: "text", text: "Generated text" }]),
  streamText: () => Stream.fromIterable(mockStreamParts),
});

const mockLanguageModelLayer = Layer.effect(LanguageModel.LanguageModel, mockLanguageModel);

const testLayer = liveLayer.pipe(
  Layer.provide(streamManagerLiveLayer),
  Layer.provide(StreamStorage.inMemoryLayer),
  Layer.provide(mockLanguageModelLayer),
);

describe("AgentManager", () => {
  it.effect("subscribe delegates to StreamManager", () =>
    Effect.gen(function* () {
      const agent = yield* AgentManager;
      const path = StreamPath.make("test/subscribe");

      // Append an event directly (without generate flag)
      yield* agent.append({
        path,
        event: EventInput.make({
          type: EventType.make("user"),
          payload: { message: "test", generate: false },
        }),
      });

      // Subscribe and collect
      const events = yield* agent.subscribe({ path }).pipe(Stream.runCollect);
      const arr = Chunk.toReadonlyArray(events);

      expect(arr.length).toBe(1);
      expect(arr[0].payload["message"]).toBe("test");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("append with non-trigger event type does not trigger LLM", () =>
    Effect.gen(function* () {
      const agent = yield* AgentManager;
      const path = StreamPath.make("test/no-generate");

      // Append with a type that doesn't trigger generation
      yield* agent.append({
        path,
        event: EventInput.make({
          type: EventType.make("iterate:agent:state:updated"),
          payload: { content: "hi" },
        }),
      });

      const events = yield* agent.subscribe({ path }).pipe(Stream.runCollect);
      const arr = Chunk.toReadonlyArray(events);

      // Should only have the original event, no assistant response
      expect(arr.length).toBe(1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("send-user-message event triggers LLM generation", () =>
    Effect.gen(function* () {
      const agent = yield* AgentManager;
      const path = StreamPath.make("test/generate");

      // Append user message with the trigger event type
      yield* agent.append({
        path,
        event: EventInput.make({
          type: EventType.make("iterate:agent:action:send-user-message:called"),
          payload: { content: "say hello" },
        }),
      });

      const events = yield* agent.subscribe({ path }).pipe(Stream.runCollect);
      const arr = Chunk.toReadonlyArray(events);

      // Should have: user message + SSE response events
      expect(arr.length).toBeGreaterThan(1);

      // First event is user message
      expect(arr[0].type).toBe("iterate:agent:action:send-user-message:called");

      // Remaining events are SSE parts
      const sseEvents = arr.filter((e) => e.type === "iterate:llm:response:sse");
      expect(sseEvents.length).toBeGreaterThan(0);

      // Should have text-delta and finish parts
      const textDelta = sseEvents.find((e) => e.payload["type"] === "text-delta");
      const finish = sseEvents.find((e) => e.payload["type"] === "finish");
      expect(textDelta).toBeDefined();
      expect(finish).toBeDefined();
      expect(finish?.payload["reason"]).toBe("stop");
    }).pipe(Effect.provide(testLayer)),
  );
});
