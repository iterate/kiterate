/**
 * StreamManager test suite
 */
import { describe, expect, it } from "@effect/vitest";
import { Chunk, Effect, Layer, Stream } from "effect";

import { Offset, StreamPath } from "../../domain.js";
import * as StreamStorage from "../stream-storage/index.js";
import * as StreamManager from "./index.js";
import { liveLayer } from "./live.js";

const testLayer = liveLayer.pipe(Layer.provide(StreamStorage.inMemoryLayer));

describe("StreamManager", () => {
  it.effect("late subscriber receives historical events", () =>
    Effect.gen(function* () {
      const manager = yield* StreamManager.StreamManager;
      const path = StreamPath.make("test/durable");

      // Append events before subscribing
      yield* manager.append({ path, payload: { message: "first" } });
      yield* manager.append({ path, payload: { message: "second" } });

      // Late subscriber should get history
      const events = yield* manager.subscribe({ path }).pipe(Stream.take(2), Stream.runCollect);

      const arr = Chunk.toReadonlyArray(events);
      expect(arr).toHaveLength(2);
      expect(arr[0].offset).toBe("0000000000000000");
      expect(arr[0].payload).toEqual({ message: "first" });
      expect(arr[1].offset).toBe("0000000000000001");
      expect(arr[1].payload).toEqual({ message: "second" });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("subscribe with from skips earlier events", () =>
    Effect.gen(function* () {
      const manager = yield* StreamManager.StreamManager;
      const path = StreamPath.make("test/offset");

      // Append 3 events
      yield* manager.append({ path, payload: { idx: 0 } });
      yield* manager.append({ path, payload: { idx: 1 } });
      yield* manager.append({ path, payload: { idx: 2 } });

      // Subscribe from offset 1 (skip offset 0)
      const events = yield* manager
        .subscribe({ path, from: Offset.make("0000000000000001") })
        .pipe(Stream.take(2), Stream.runCollect);

      const arr = Chunk.toReadonlyArray(events);
      expect(arr.map((e) => e.offset)).toEqual(["0000000000000001", "0000000000000002"]);
      expect(arr.map((e) => e.payload)).toEqual([{ idx: 1 }, { idx: 2 }]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("historical subscribe does not receive later events", () =>
    Effect.gen(function* () {
      const manager = yield* StreamManager.StreamManager;
      const path = StreamPath.make("test/historical-only");

      // Append historical event
      yield* manager.append({ path, payload: { type: "historical" } });

      // Historical subscriber should complete after existing events
      const events = yield* manager.subscribe({ path }).pipe(Stream.runCollect);

      const arr = Chunk.toReadonlyArray(events);
      expect(arr).toHaveLength(1);
      expect(arr[0].payload).toEqual({ type: "historical" });
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("subscribe with live=true receives only live events", () =>
    Effect.gen(function* () {
      const manager = yield* StreamManager.StreamManager;
      const path = StreamPath.make("test/live-only");

      // Append historical event
      yield* manager.append({ path, payload: { type: "historical" } });

      // Subscribe with live=true (live only)
      const subscriber = yield* manager
        .subscribe({ path, live: true })
        .pipe(Stream.take(1), Stream.runCollect, Effect.fork);

      yield* Effect.sleep("1 millis");

      // Append live event
      yield* manager.append({ path, payload: { type: "live" } });

      const events = yield* subscriber;
      const arr = Chunk.toReadonlyArray(events);

      // Should only have the live event, not historical
      expect(arr).toHaveLength(1);
      expect(arr[0].offset).toBe("0000000000000001");
      expect(arr[0].payload).toEqual({ type: "live" });
    }).pipe(Effect.provide(testLayer)),
  );
});
