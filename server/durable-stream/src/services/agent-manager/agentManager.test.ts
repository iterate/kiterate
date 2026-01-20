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

  it.effect("append without generate flag does not trigger LLM", () =>
    Effect.gen(function* () {
      const agent = yield* AgentManager;
      const path = StreamPath.make("test/no-generate");

      // Append with generate: false
      yield* agent.append({
        path,
        event: EventInput.make({
          type: EventType.make("user"),
          payload: { role: "user", content: "hi", generate: false },
        }),
      });

      const events = yield* agent.subscribe({ path }).pipe(Stream.runCollect);
      const arr = Chunk.toReadonlyArray(events);

      // Should only have the user message, no assistant response
      expect(arr.length).toBe(1);
      expect(arr[0].payload["role"]).toBe("user");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("append with role=user triggers LLM generation", () =>
    Effect.gen(function* () {
      const agent = yield* AgentManager;
      const path = StreamPath.make("test/generate");

      // Append user message (default behavior should trigger LLM)
      yield* agent.append({
        path,
        event: EventInput.make({
          type: EventType.make("user"),
          payload: { role: "user", content: "say hello" },
        }),
      });

      const events = yield* agent.subscribe({ path }).pipe(Stream.runCollect);
      const arr = Chunk.toReadonlyArray(events);

      // Should have: user message + text events + finish
      expect(arr.length).toBeGreaterThan(1);

      // First event is user message
      expect(arr[0].payload["role"]).toBe("user");

      // Should have assistant events
      const assistantEvents = arr.filter((e) => e.payload["role"] === "assistant");
      expect(assistantEvents.length).toBeGreaterThan(0);

      // Should have a finish event
      const finishEvent = assistantEvents.find((e) => e.payload["type"] === "finish");
      expect(finishEvent).toBeDefined();
      expect(finishEvent?.payload["reason"]).toBe("stop");
    }).pipe(Effect.provide(testLayer)),
  );
});
