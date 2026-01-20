/**
 * StreamManager test suite
 */
import { describe, expect, it } from "@effect/vitest";
import { Chunk, Effect, Layer, Stream } from "effect";

import { EventInput, EventType, Offset, StreamPath } from "../../domain.js";
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
      yield* manager.append({
        path,
        event: EventInput.make({ type: EventType.make("test"), payload: { message: "first" } }),
      });
      yield* manager.append({
        path,
        event: EventInput.make({ type: EventType.make("test"), payload: { message: "second" } }),
      });

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

  it.effect("subscribe with from skips seen events (exclusive)", () =>
    Effect.gen(function* () {
      const manager = yield* StreamManager.StreamManager;
      const path = StreamPath.make("test/offset");

      // Append 3 events
      yield* manager.append({
        path,
        event: EventInput.make({ type: EventType.make("test"), payload: { idx: 0 } }),
      });
      yield* manager.append({
        path,
        event: EventInput.make({ type: EventType.make("test"), payload: { idx: 1 } }),
      });
      yield* manager.append({
        path,
        event: EventInput.make({ type: EventType.make("test"), payload: { idx: 2 } }),
      });

      // Subscribe with from=offset1 meaning "I've seen offset 1, give me what's after"
      const events = yield* manager
        .subscribe({ path, from: Offset.make("0000000000000001") })
        .pipe(Stream.runCollect);

      const arr = Chunk.toReadonlyArray(events);
      // Should only get offset 2 (after offset 1)
      expect(arr.map((e) => e.offset)).toEqual(["0000000000000002"]);
      expect(arr.map((e) => e.payload)).toEqual([{ idx: 2 }]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("historical subscribe does not receive later events", () =>
    Effect.gen(function* () {
      const manager = yield* StreamManager.StreamManager;
      const path = StreamPath.make("test/historical-only");

      // Append historical event
      yield* manager.append({
        path,
        event: EventInput.make({ type: EventType.make("test"), payload: { kind: "historical" } }),
      });

      // Historical subscriber should complete after existing events
      const events = yield* manager.subscribe({ path }).pipe(Stream.runCollect);

      const arr = Chunk.toReadonlyArray(events);
      expect(arr).toHaveLength(1);
      expect(arr[0].payload).toEqual({ kind: "historical" });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("resubscribe after processing resumes without duplicates", () =>
    Effect.gen(function* () {
      const manager = yield* StreamManager.StreamManager;
      const path = StreamPath.make("test/resubscribe");

      // Append 5 events
      for (let i = 0; i < 5; i++) {
        yield* manager.append({
          path,
          event: EventInput.make({ type: EventType.make("test"), payload: { idx: i } }),
        });
      }

      // First subscription: get first 2 events
      const firstBatch = yield* manager.subscribe({ path }).pipe(Stream.take(2), Stream.runCollect);
      const firstArr = Chunk.toReadonlyArray(firstBatch);
      expect(firstArr.map((e) => e.payload["idx"])).toEqual([0, 1]);

      // Get the last processed offset
      const lastProcessedOffset = firstArr[1].offset;
      expect(lastProcessedOffset).toBe("0000000000000001");

      // Resubscribe with from=lastProcessedOffset (meaning "I've seen this, give me what's after")
      const secondBatch = yield* manager
        .subscribe({ path, from: lastProcessedOffset })
        .pipe(Stream.runCollect);
      const secondArr = Chunk.toReadonlyArray(secondBatch);

      // Should get events 2, 3, 4 - no duplicate of event 1
      expect(secondArr.map((e) => e.payload["idx"])).toEqual([2, 3, 4]);
      expect(secondArr.map((e) => e.offset)).toEqual([
        "0000000000000002",
        "0000000000000003",
        "0000000000000004",
      ]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("subscribe with live=true receives history then live events", () =>
    Effect.gen(function* () {
      const manager = yield* StreamManager.StreamManager;
      const path = StreamPath.make("test/history-and-live");

      // Append historical event
      yield* manager.append({
        path,
        event: EventInput.make({ type: EventType.make("test"), payload: { kind: "historical" } }),
      });

      // Subscribe with live=true (history + live)
      const subscriber = yield* manager
        .subscribe({ path, live: true })
        .pipe(Stream.take(2), Stream.runCollect, Effect.fork);

      yield* Effect.sleep("1 millis");

      // Append live event
      yield* manager.append({
        path,
        event: EventInput.make({ type: EventType.make("test"), payload: { kind: "live" } }),
      });

      const events = yield* subscriber;
      const arr = Chunk.toReadonlyArray(events);

      // Should have both historical and live events
      expect(arr).toHaveLength(2);
      expect(arr[0].offset).toBe("0000000000000000");
      expect(arr[0].payload).toEqual({ kind: "historical" });
      expect(arr[1].offset).toBe("0000000000000001");
      expect(arr[1].payload).toEqual({ kind: "live" });
    }).pipe(Effect.provide(testLayer)),
  );
});
