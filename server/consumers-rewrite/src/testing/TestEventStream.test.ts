import { it, expect } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { StreamPath } from "../domain.js";
import { EventSchema } from "../events.js";
import { makeTestEventStream } from "./TestEventStream.js";

// Simple test event schemas
const PingEvent = EventSchema.make("test:ping", {});
const PongEvent = EventSchema.make("test:pong", {});
const MessageEvent = EventSchema.make("test:message", { content: Schema.String });

// -------------------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------------------

it.scoped("waitForEvent consumes events - each call returns the next one", () =>
  Effect.gen(function* () {
    const stream = yield* makeTestEventStream(StreamPath.make("test"));

    // Append three ping events
    yield* stream.append(PingEvent.make());
    yield* stream.append(PingEvent.make());
    yield* stream.append(PingEvent.make());

    // Each waitForEvent returns the NEXT unconsumed event
    const ping1 = yield* stream.waitForEvent(PingEvent);
    const ping2 = yield* stream.waitForEvent(PingEvent);
    const ping3 = yield* stream.waitForEvent(PingEvent);

    // They should be different events (different offsets)
    expect(ping1.offset).toBe("0000000000000000");
    expect(ping2.offset).toBe("0000000000000001");
    expect(ping3.offset).toBe("0000000000000002");
  }),
);

it.scoped("waitForEvent waits for future events if none available", () =>
  Effect.gen(function* () {
    const stream = yield* makeTestEventStream(StreamPath.make("test"));

    // Start waiting for a ping (none exist yet)
    const pingFiber = yield* stream.waitForEvent(PingEvent).pipe(Effect.fork);

    // Append a ping
    yield* stream.append(PingEvent.make());

    // The wait should resolve
    const ping = yield* Effect.fromFiber(pingFiber);
    expect(ping.offset).toBe("0000000000000000");
  }),
);

it.scoped("waitForEvent tracks consumption per event type independently", () =>
  Effect.gen(function* () {
    const stream = yield* makeTestEventStream(StreamPath.make("test"));

    // Interleave ping and pong events
    yield* stream.append(PingEvent.make()); // offset 0
    yield* stream.append(PongEvent.make()); // offset 1
    yield* stream.append(PingEvent.make()); // offset 2
    yield* stream.append(PongEvent.make()); // offset 3

    // Wait for pings - should get 0 and 2 (skipping pongs)
    const ping1 = yield* stream.waitForEvent(PingEvent);
    const ping2 = yield* stream.waitForEvent(PingEvent);
    expect(ping1.offset).toBe("0000000000000000");
    expect(ping2.offset).toBe("0000000000000002");

    // Wait for pongs - should get 1 and 3 (independent consumption)
    const pong1 = yield* stream.waitForEvent(PongEvent);
    const pong2 = yield* stream.waitForEvent(PongEvent);
    expect(pong1.offset).toBe("0000000000000001");
    expect(pong2.offset).toBe("0000000000000003");
  }),
);

it.scoped("waitForEventCount returns multiple events at once", () =>
  Effect.gen(function* () {
    const stream = yield* makeTestEventStream(StreamPath.make("test"));

    yield* stream.append(PingEvent.make());
    yield* stream.append(PingEvent.make());
    yield* stream.append(PingEvent.make());

    // Get first 2 pings
    const first2 = yield* stream.waitForEventCount(PingEvent, 2);
    expect(first2).toHaveLength(2);
    expect(first2[0].offset).toBe("0000000000000000");
    expect(first2[1].offset).toBe("0000000000000001");

    // Get next 1 ping (consumed state continues)
    const [next] = yield* stream.waitForEventCount(PingEvent, 1);
    expect(next.offset).toBe("0000000000000002");
  }),
);

it.scoped("waitForEvent returns typed payload", () =>
  Effect.gen(function* () {
    const stream = yield* makeTestEventStream(StreamPath.make("test"));

    yield* stream.append(MessageEvent.make({ content: "hello" }));

    const msg = yield* stream.waitForEvent(MessageEvent);

    // TypeScript knows msg.payload has content property
    expect(msg.payload.content).toBe("hello");
  }),
);
