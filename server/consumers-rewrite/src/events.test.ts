import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { EventInput, EventType, Offset, Payload } from "./domain.js";
import { ConfigSetEvent, EventSchema, UserMessageEvent } from "./events.js";
import { RequestEndedEvent, ResponseSseEvent } from "./processors/llm-loop/events.js";

describe("EventSchema", () => {
  // ---------------------------------------------------------------------------
  // Creating events
  // ---------------------------------------------------------------------------

  describe("make", () => {
    it("creates typed events with payload", () => {
      const event = UserMessageEvent.make({ content: "Hello, world!" });

      expect(event.type).toBe("iterate:agent:action:send-user-message:called");
      expect(event.payload).toEqual({ content: "Hello, world!" });
    });

    it("creates events with complex payloads", () => {
      const event = ResponseSseEvent.make({
        part: { type: "text-delta", delta: "Hi" },
        requestOffset: Offset.make("0000000000000001"),
      });

      expect(event.type).toBe("iterate:llm-loop:response:sse");
      expect(event.payload).toEqual({
        part: { type: "text-delta", delta: "Hi" },
        requestOffset: "0000000000000001",
      });
    });

    it("creates events with literal union payloads", () => {
      const openai = ConfigSetEvent.make({ model: "openai" });
      const grok = ConfigSetEvent.make({ model: "grok" });

      expect(openai.payload).toEqual({ model: "openai" });
      expect(grok.payload).toEqual({ model: "grok" });
    });

    it("allows omitting payload for empty schemas", () => {
      const EmptyEvent = EventSchema.make("test:empty", {});
      const event = EmptyEvent.make();

      expect(event.type).toBe("test:empty");
      expect(event.payload).toEqual({});
    });
  });

  // ---------------------------------------------------------------------------
  // Type guards (is)
  // ---------------------------------------------------------------------------

  describe("is", () => {
    it("narrows type when event matches", () => {
      const event = UserMessageEvent.make({ content: "test" });

      if (UserMessageEvent.is(event)) {
        // TypeScript knows payload.content is string
        const content: string = event.payload.content;
        expect(content).toBe("test");
      } else {
        throw new Error("Expected event to match");
      }
    });

    it("returns false for non-matching event type", () => {
      const event = ConfigSetEvent.make({ model: "openai" });

      expect(UserMessageEvent.is(event)).toBe(false);
    });

    it("returns true for matching type regardless of payload (type-only check)", () => {
      // Note: .is() only checks the event type, not payload structure.
      // For runtime payload validation, use .decode() or .decodeOption()
      const event = EventInput.make({
        type: EventType.make("iterate:agent:action:send-user-message:called"),
        payload: { wrong: "field" } as Payload,
      });

      // .is() returns true because the type matches
      expect(UserMessageEvent.is(event)).toBe(true);
      // .decodeOption() returns None because the payload is invalid
      expect(Option.isNone(UserMessageEvent.decodeOption(event))).toBe(true);
    });

    it("works in switch-like patterns", () => {
      const events = [
        UserMessageEvent.make({ content: "Hello" }),
        ConfigSetEvent.make({ model: "grok" }),
        RequestEndedEvent.make({ requestOffset: Offset.make("0000000000000001") }),
      ];

      const results: string[] = [];

      for (const event of events) {
        if (UserMessageEvent.is(event)) {
          results.push(`user: ${event.payload.content}`);
        } else if (ConfigSetEvent.is(event)) {
          results.push(`config: ${event.payload.model}`);
        } else if (RequestEndedEvent.is(event)) {
          results.push("ended");
        }
      }

      expect(results).toEqual(["user: Hello", "config: grok", "ended"]);
    });
  });

  // ---------------------------------------------------------------------------
  // Option-based parsing (decodeOption)
  // ---------------------------------------------------------------------------

  describe("decodeOption", () => {
    it("returns Some for matching events", () => {
      const event = UserMessageEvent.make({ content: "parsed!" });
      const result = UserMessageEvent.decodeOption(event);

      expect(Option.isSome(result)).toBe(true);
      expect(Option.getOrThrow(result)).toEqual({ content: "parsed!" });
    });

    it("returns None for wrong event type", () => {
      const event = ConfigSetEvent.make({ model: "openai" });
      const result = UserMessageEvent.decodeOption(event);

      expect(Option.isNone(result)).toBe(true);
    });

    it("returns None for invalid payload", () => {
      const event = EventInput.make({
        type: EventType.make("iterate:agent:action:send-user-message:called"),
        payload: { content: 123 } as unknown as Payload, // wrong type
      });

      const result = UserMessageEvent.decodeOption(event);
      expect(Option.isNone(result)).toBe(true);
    });

    it("enables elegant reducer patterns", () => {
      const events = [
        UserMessageEvent.make({ content: "Hello" }),
        ConfigSetEvent.make({ model: "grok" }),
        UserMessageEvent.make({ content: "World" }),
      ];

      // Collect all user messages
      const messages = events.flatMap((e) =>
        Option.match(UserMessageEvent.decodeOption(e), {
          onNone: () => [],
          onSome: (p) => [p.content],
        }),
      );

      expect(messages).toEqual(["Hello", "World"]);
    });
  });

  // ---------------------------------------------------------------------------
  // Effect-based parsing (decode)
  // ---------------------------------------------------------------------------

  describe("decode", () => {
    it("succeeds for matching events", async () => {
      const event = RequestEndedEvent.make({
        requestOffset: Offset.make("0000000000000042"),
      });

      const result = await Effect.runPromise(RequestEndedEvent.decode(event));

      expect(result).toEqual({ requestOffset: "0000000000000042" });
    });

    it("fails with ParseError for wrong type", async () => {
      const event = UserMessageEvent.make({ content: "test" });

      const result = await Effect.runPromiseExit(ConfigSetEvent.decode(event));

      expect(result._tag).toBe("Failure");
    });

    it("fails with ParseError for invalid payload", async () => {
      const event = EventInput.make({
        type: EventType.make("iterate:agent:config:set"),
        payload: { model: "invalid-model" } as Payload,
      });

      const result = await Effect.runPromiseExit(ConfigSetEvent.decode(event));

      expect(result._tag).toBe("Failure");
    });

    it("composes with Effect pipelines", async () => {
      const event = UserMessageEvent.make({ content: "  trim me  " });

      const processed = await Effect.runPromise(
        UserMessageEvent.decode(event).pipe(Effect.map((p) => p.content.trim().toUpperCase())),
      );

      expect(processed).toBe("TRIM ME");
    });
  });

  // ---------------------------------------------------------------------------
  // Custom schemas
  // ---------------------------------------------------------------------------

  describe("custom EventSchema", () => {
    const CustomEvent = EventSchema.make("my-app:custom:event", {
      id: Offset,
      tags: EventType.pipe((s) => s), // reuse branded types
    });

    it("works with custom field types", () => {
      const event = CustomEvent.make({
        id: Offset.make("0000000000000001"),
        tags: EventType.make("tag-value"),
      });

      expect(event.payload).toEqual({
        id: "0000000000000001",
        tags: "tag-value",
      });

      expect(CustomEvent.is(event)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Type alias pattern
  // ---------------------------------------------------------------------------

  describe("Type alias", () => {
    // Pattern: value + type alias using .Type
    const TestEvent = EventSchema.make("test:typed:event", {
      message: Schema.String,
      count: Schema.Number,
    });
    type TestEvent = typeof TestEvent.Type;

    it("provides named type via .Type phantom", () => {
      const event = TestEvent.make({ message: "hello", count: 42 });

      // Can use the type alias for annotations
      const annotated: TestEvent = event;

      expect(annotated.type).toBe("test:typed:event");
      expect(annotated.payload).toEqual({ message: "hello", count: 42 });
    });

    it("type alias works with function signatures", () => {
      // The type alias can be used in function signatures
      const processEvent = (e: TestEvent): string => e.payload.message;

      const event = TestEvent.make({ message: "typed", count: 0 });
      expect(processEvent(event)).toBe("typed");
    });
  });
});
