/**
 * Tests for the Interceptor system
 *
 * Tests the event interception mechanism:
 * - First-match-wins behavior
 * - Event type prefixing with "intercepted:"
 * - Interception chain tracking to prevent re-interception
 * - JSONata matching expressions
 */
import { describe, expect, it } from "@effect/vitest";
import { Chunk, Effect, Layer, Stream } from "effect";

import { EventInput, EventType, StreamPath } from "../domain.js";
import * as StreamManager from "../services/stream-manager/index.js";
import * as StreamStorage from "../services/stream-storage/index.js";
import { InterceptorRegistry, emptyLayer } from "./service.js";
import { INTERCEPTED_PREFIX, type Interceptor } from "./interceptor.js";
import * as Matcher from "./matcher.js";

// -------------------------------------------------------------------------------------
// Test Setup
// -------------------------------------------------------------------------------------

/**
 * Creates a test layer with pre-configured interceptors.
 * This avoids needing to access InterceptorRegistry in the test.
 */
const makeTestLayerWithInterceptors = (...interceptors: Interceptor[]) => {
  const registryLayer = Layer.effect(
    InterceptorRegistry,
    Effect.sync(() => {
      return InterceptorRegistry.of({
        list: () => interceptors,
        register: (i) => {
          interceptors.push(i);
        },
      });
    }),
  );

  return StreamManager.liveLayer.pipe(
    Layer.provide(StreamStorage.inMemoryLayer),
    Layer.provide(registryLayer),
  );
};

const testLayerWithEmptyRegistry = StreamManager.liveLayer.pipe(
  Layer.provide(StreamStorage.inMemoryLayer),
  Layer.provide(emptyLayer),
);

// -------------------------------------------------------------------------------------
// Matcher Tests (unit tests - no Effect context needed)
// -------------------------------------------------------------------------------------

describe("Matcher", () => {
  it("matches exact event type", () => {
    const interceptor = { name: "test", match: `type = "user-message"` };
    const event = EventInput.make({
      type: EventType.make("user-message"),
      payload: {},
    });

    expect(Matcher.matches(interceptor, event)).toBe(true);
  });

  it("does not match different event type", () => {
    const interceptor = { name: "test", match: `type = "user-message"` };
    const event = EventInput.make({
      type: EventType.make("system-message"),
      payload: {},
    });

    expect(Matcher.matches(interceptor, event)).toBe(false);
  });

  it("matches using $contains for partial type match", () => {
    const interceptor = { name: "test", match: `$contains(type, "message")` };

    const userMsg = EventInput.make({
      type: EventType.make("user-message"),
      payload: {},
    });
    const sysMsg = EventInput.make({
      type: EventType.make("system-message"),
      payload: {},
    });
    const configEvt = EventInput.make({
      type: EventType.make("config-set"),
      payload: {},
    });

    expect(Matcher.matches(interceptor, userMsg)).toBe(true);
    expect(Matcher.matches(interceptor, sysMsg)).toBe(true);
    expect(Matcher.matches(interceptor, configEvt)).toBe(false);
  });

  it("matches based on payload properties", () => {
    const interceptor = { name: "test", match: `payload.sensitive = true` };

    const sensitiveEvent = EventInput.make({
      type: EventType.make("user-input"),
      payload: { sensitive: true, content: "secret" },
    });
    const normalEvent = EventInput.make({
      type: EventType.make("user-input"),
      payload: { content: "normal" },
    });

    expect(Matcher.matches(interceptor, sensitiveEvent)).toBe(true);
    expect(Matcher.matches(interceptor, normalEvent)).toBe(false);
  });

  it("handles complex JSONata expressions", () => {
    const interceptor = {
      name: "test",
      match: `type = "user-message" and payload.length > 100`,
    };

    const longMsg = EventInput.make({
      type: EventType.make("user-message"),
      payload: { length: 150 },
    });
    const shortMsg = EventInput.make({
      type: EventType.make("user-message"),
      payload: { length: 50 },
    });
    const wrongType = EventInput.make({
      type: EventType.make("system-message"),
      payload: { length: 150 },
    });

    expect(Matcher.matches(interceptor, longMsg)).toBe(true);
    expect(Matcher.matches(interceptor, shortMsg)).toBe(false);
    expect(Matcher.matches(interceptor, wrongType)).toBe(false);
  });
});

// -------------------------------------------------------------------------------------
// Integration Tests (with StreamManager)
// -------------------------------------------------------------------------------------

describe("Interceptor Integration", () => {
  it.effect("intercepts matching events and prefixes type", () =>
    Effect.gen(function* () {
      const manager = yield* StreamManager.StreamManager;
      const path = StreamPath.make("test/intercept");

      // Append a user-message event
      const storedEvent = yield* manager.append({
        path,
        event: EventInput.make({
          type: EventType.make("user-message"),
          payload: { content: "hello" },
        }),
      });

      // Event should be stored with intercepted: prefix
      expect(storedEvent.type).toBe(`${INTERCEPTED_PREFIX}user-message`);
      expect(storedEvent.interceptions).toHaveLength(1);
      expect(storedEvent.interceptions[0].interceptor).toBe("user-message-interceptor");
      expect(storedEvent.interceptions[0].originalType).toBe("user-message");
      // Payload should be unchanged
      expect(storedEvent.payload).toEqual({ content: "hello" });
    }).pipe(
      Effect.provide(
        makeTestLayerWithInterceptors({
          name: "user-message-interceptor",
          match: `type = "user-message"`,
        }),
      ),
    ),
  );

  it.effect("does not intercept non-matching events", () =>
    Effect.gen(function* () {
      const manager = yield* StreamManager.StreamManager;
      const path = StreamPath.make("test/no-intercept");

      // Append a different event type
      const storedEvent = yield* manager.append({
        path,
        event: EventInput.make({
          type: EventType.make("system-message"),
          payload: { content: "system" },
        }),
      });

      // Event should NOT be intercepted
      expect(storedEvent.type).toBe("system-message");
      expect(storedEvent.interceptions).toHaveLength(0);
    }).pipe(
      Effect.provide(
        makeTestLayerWithInterceptors({
          name: "user-message-interceptor",
          match: `type = "user-message"`,
        }),
      ),
    ),
  );

  it.effect("first-match-wins: only first matching interceptor intercepts", () =>
    Effect.gen(function* () {
      const manager = yield* StreamManager.StreamManager;
      const path = StreamPath.make("test/first-wins");

      const storedEvent = yield* manager.append({
        path,
        event: EventInput.make({
          type: EventType.make("user-message"),
          payload: {},
        }),
      });

      // Only first interceptor should have intercepted
      expect(storedEvent.interceptions).toHaveLength(1);
      expect(storedEvent.interceptions[0].interceptor).toBe("first-interceptor");
    }).pipe(
      Effect.provide(
        makeTestLayerWithInterceptors(
          { name: "first-interceptor", match: `type = "user-message"` },
          { name: "second-interceptor", match: `type = "user-message"` },
        ),
      ),
    ),
  );

  it.effect("re-emitted events with interceptions array skip already-run interceptors", () =>
    Effect.gen(function* () {
      const manager = yield* StreamManager.StreamManager;
      const path = StreamPath.make("test/chain");

      // First append: first interceptor intercepts
      const intercepted = yield* manager.append({
        path,
        event: EventInput.make({
          type: EventType.make("user-message"),
          payload: { content: "original" },
        }),
      });

      expect(intercepted.type).toBe(`${INTERCEPTED_PREFIX}user-message`);
      expect(intercepted.interceptions[0].interceptor).toBe("first-interceptor");

      // "Re-emit" by appending a new event with the interceptions array carried forward
      // This simulates what a processor would do after handling the intercepted event
      const reEmitted = yield* manager.append({
        path,
        event: new EventInput({
          type: EventType.make("user-message"),
          payload: { content: "transformed" },
          interceptions: intercepted.interceptions, // Carry forward
        }),
      });

      // Second interceptor should now intercept (first is skipped due to interceptions array)
      expect(reEmitted.type).toBe(`${INTERCEPTED_PREFIX}user-message`);
      expect(reEmitted.interceptions).toHaveLength(2);
      expect(reEmitted.interceptions[0].interceptor).toBe("first-interceptor");
      expect(reEmitted.interceptions[1].interceptor).toBe("second-interceptor");
    }).pipe(
      Effect.provide(
        makeTestLayerWithInterceptors(
          { name: "first-interceptor", match: `type = "user-message"` },
          { name: "second-interceptor", match: `type = "user-message"` },
        ),
      ),
    ),
  );

  it.effect("after all interceptors have run, event is stored without interception", () =>
    Effect.gen(function* () {
      const manager = yield* StreamManager.StreamManager;
      const path = StreamPath.make("test/final");

      // First append: gets intercepted
      const intercepted = yield* manager.append({
        path,
        event: EventInput.make({
          type: EventType.make("user-message"),
          payload: { content: "original" },
        }),
      });

      expect(intercepted.type).toBe(`${INTERCEPTED_PREFIX}user-message`);

      // Re-emit with interceptions carried forward
      const final = yield* manager.append({
        path,
        event: new EventInput({
          type: EventType.make("user-message"),
          payload: { content: "final" },
          interceptions: intercepted.interceptions,
        }),
      });

      // No more interceptors to run, so event is stored as-is
      expect(final.type).toBe("user-message");
      // Interceptions array is preserved for audit trail
      expect(final.interceptions).toHaveLength(1);
      expect(final.interceptions[0].interceptor).toBe("only-interceptor");
    }).pipe(
      Effect.provide(
        makeTestLayerWithInterceptors({
          name: "only-interceptor",
          match: `type = "user-message"`,
        }),
      ),
    ),
  );

  it.effect("subscribers see both intercepted and re-emitted events", () =>
    Effect.gen(function* () {
      const manager = yield* StreamManager.StreamManager;
      const path = StreamPath.make("test/subscriber-view");

      // Append original event (gets intercepted)
      const intercepted = yield* manager.append({
        path,
        event: EventInput.make({
          type: EventType.make("user-message"),
          payload: { content: "original" },
        }),
      });

      // Re-emit transformed event
      yield* manager.append({
        path,
        event: new EventInput({
          type: EventType.make("user-message"),
          payload: { content: "transformed" },
          interceptions: intercepted.interceptions,
        }),
      });

      // Read all events - should see both
      const events = yield* manager.read({ path }).pipe(Stream.runCollect);
      const arr = Chunk.toReadonlyArray(events);

      expect(arr).toHaveLength(2);

      // First event: intercepted
      expect(arr[0].type).toBe(`${INTERCEPTED_PREFIX}user-message`);
      expect(arr[0].payload).toEqual({ content: "original" });

      // Second event: re-emitted (not re-intercepted)
      expect(arr[1].type).toBe("user-message");
      expect(arr[1].payload).toEqual({ content: "transformed" });
    }).pipe(
      Effect.provide(
        makeTestLayerWithInterceptors({
          name: "test-interceptor",
          match: `type = "user-message"`,
        }),
      ),
    ),
  );

  it.effect("no interceptors registered means no interception", () =>
    Effect.gen(function* () {
      const manager = yield* StreamManager.StreamManager;
      const path = StreamPath.make("test/no-interceptors");

      const storedEvent = yield* manager.append({
        path,
        event: EventInput.make({
          type: EventType.make("user-message"),
          payload: { content: "hello" },
        }),
      });

      expect(storedEvent.type).toBe("user-message");
      expect(storedEvent.interceptions).toHaveLength(0);
    }).pipe(Effect.provide(testLayerWithEmptyRegistry)),
  );
});
