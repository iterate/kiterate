/**
 * StreamManager test suite
 */
import { describe, expect, it } from "@effect/vitest";
import { Chunk, Deferred, Effect, Fiber, Layer, Ref, Stream } from "effect";

import { EventInput, EventType, Offset, StreamPath } from "../../domain.js";
import * as StreamStorage from "../stream-storage/index.js";
import * as StreamManager from "./index.js";
import { liveLayer } from "./live.js";

const testLayer = liveLayer.pipe(Layer.provide(StreamStorage.inMemoryLayer));

describe("StreamManager", () => {
  it.effect("read returns historical events", () =>
    Effect.gen(function* () {
      const manager = yield* StreamManager.StreamManager;
      const path = StreamPath.make("test/durable");

      // Append events before reading
      yield* manager.append({
        path,
        event: EventInput.make({ type: EventType.make("test"), payload: { message: "first" } }),
      });
      yield* manager.append({
        path,
        event: EventInput.make({ type: EventType.make("test"), payload: { message: "second" } }),
      });

      // Read should get history and complete
      const events = yield* manager.read({ path }).pipe(Stream.runCollect);

      const arr = Chunk.toReadonlyArray(events);
      expect(arr).toHaveLength(2);
      expect(arr[0].offset).toBe("0000000000000000");
      expect(arr[0].payload).toEqual({ message: "first" });
      expect(arr[1].offset).toBe("0000000000000001");
      expect(arr[1].payload).toEqual({ message: "second" });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("read with from skips seen events (exclusive)", () =>
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

      // Read with from=offset1 meaning "I've seen offset 1, give me what's after"
      const events = yield* manager
        .read({ path, from: Offset.make("0000000000000001") })
        .pipe(Stream.runCollect);

      const arr = Chunk.toReadonlyArray(events);
      // Should only get offset 2 (after offset 1)
      expect(arr.map((e) => e.offset)).toEqual(["0000000000000002"]);
      expect(arr.map((e) => e.payload)).toEqual([{ idx: 2 }]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("read does not receive later events", () =>
    Effect.gen(function* () {
      const manager = yield* StreamManager.StreamManager;
      const path = StreamPath.make("test/historical-only");

      // Append historical event
      yield* manager.append({
        path,
        event: EventInput.make({ type: EventType.make("test"), payload: { kind: "historical" } }),
      });

      // Read should complete after existing events
      const events = yield* manager.read({ path }).pipe(Stream.runCollect);

      const arr = Chunk.toReadonlyArray(events);
      expect(arr).toHaveLength(1);
      expect(arr[0].payload).toEqual({ kind: "historical" });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("read after processing resumes without duplicates", () =>
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

      // First read: get first 2 events
      const firstBatch = yield* manager.read({ path }).pipe(Stream.take(2), Stream.runCollect);
      const firstArr = Chunk.toReadonlyArray(firstBatch);
      expect(firstArr.map((e) => e.payload["idx"])).toEqual([0, 1]);

      // Get the last processed offset
      const lastProcessedOffset = firstArr[1].offset;
      expect(lastProcessedOffset).toBe("0000000000000001");

      // Read with from=lastProcessedOffset (meaning "I've seen this, give me what's after")
      const secondBatch = yield* manager
        .read({ path, from: lastProcessedOffset })
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

  it.effect("all paths read returns historical events", () =>
    Effect.gen(function* () {
      const manager = yield* StreamManager.StreamManager;
      const pathA = StreamPath.make("test/all-history/a");
      const pathB = StreamPath.make("test/all-history/b");

      yield* manager.append({
        path: pathA,
        event: EventInput.make({ type: EventType.make("test"), payload: { idx: 0 } }),
      });
      yield* manager.append({
        path: pathA,
        event: EventInput.make({ type: EventType.make("test"), payload: { idx: 1 } }),
      });
      yield* manager.append({
        path: pathB,
        event: EventInput.make({ type: EventType.make("test"), payload: { idx: 0 } }),
      });

      const events = yield* manager.read({}).pipe(Stream.runCollect);
      const arr = Chunk.toReadonlyArray(events);

      expect(arr).toHaveLength(3);

      const eventsA = arr.filter((event) => event.path === pathA);
      const eventsB = arr.filter((event) => event.path === pathB);

      expect(eventsA.map((event) => event.offset)).toEqual([
        "0000000000000000",
        "0000000000000001",
      ]);
      expect(eventsB.map((event) => event.offset)).toEqual(["0000000000000000"]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("all paths read with from filters per path", () =>
    Effect.gen(function* () {
      const manager = yield* StreamManager.StreamManager;
      const pathA = StreamPath.make("test/all-after/a");
      const pathB = StreamPath.make("test/all-after/b");

      yield* manager.append({
        path: pathA,
        event: EventInput.make({ type: EventType.make("test"), payload: { idx: 0 } }),
      });
      yield* manager.append({
        path: pathA,
        event: EventInput.make({ type: EventType.make("test"), payload: { idx: 1 } }),
      });
      yield* manager.append({
        path: pathB,
        event: EventInput.make({ type: EventType.make("test"), payload: { idx: 0 } }),
      });

      const events = yield* manager
        .read({ from: Offset.make("0000000000000000") })
        .pipe(Stream.runCollect);

      const arr = Chunk.toReadonlyArray(events);
      const eventsA = arr.filter((event) => event.path === pathA);
      const eventsB = arr.filter((event) => event.path === pathB);

      expect(arr).toHaveLength(1);
      expect(eventsA.map((event) => event.offset)).toEqual(["0000000000000001"]);
      expect(eventsB).toHaveLength(0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("all paths subscribe receives history then live events", () =>
    Effect.gen(function* () {
      const manager = yield* StreamManager.StreamManager;
      const pathA = StreamPath.make("test/all-live/a");
      const pathB = StreamPath.make("test/all-live/b");

      yield* manager.append({
        path: pathA,
        event: EventInput.make({ type: EventType.make("test"), payload: { phase: "history" } }),
      });
      yield* manager.append({
        path: pathB,
        event: EventInput.make({ type: EventType.make("test"), payload: { phase: "history" } }),
      });

      const historyReady = yield* Deferred.make<void>();
      const seenHistory = yield* Ref.make(0);
      const historyCount = 2;

      const subscriber = yield* manager.subscribe({}).pipe(
        Stream.tap(() =>
          Ref.updateAndGet(seenHistory, (count) => count + 1).pipe(
            Effect.flatMap((count) =>
              count === historyCount ? Deferred.succeed(historyReady, void 0) : Effect.void,
            ),
          ),
        ),
        Stream.take(4),
        Stream.runCollect,
        Effect.fork,
      );

      yield* Deferred.await(historyReady);

      yield* manager.append({
        path: pathA,
        event: EventInput.make({ type: EventType.make("test"), payload: { phase: "live" } }),
      });
      yield* manager.append({
        path: pathB,
        event: EventInput.make({ type: EventType.make("test"), payload: { phase: "live" } }),
      });

      const events = yield* Fiber.join(subscriber);
      const arr = Chunk.toReadonlyArray(events);

      expect(arr).toHaveLength(4);

      const phases = arr.map((event) => event.payload["phase"]);
      expect(phases.slice(0, 2)).toEqual(["history", "history"]);
      expect(phases.slice(2)).toEqual(["live", "live"]);

      const eventsA = arr.filter((event) => event.path === pathA);
      const eventsB = arr.filter((event) => event.path === pathB);

      expect(eventsA.map((event) => event.offset)).toEqual([
        "0000000000000000",
        "0000000000000001",
      ]);
      expect(eventsB.map((event) => event.offset)).toEqual([
        "0000000000000000",
        "0000000000000001",
      ]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("subscribe with from resumes without duplicates", () =>
    Effect.gen(function* () {
      const manager = yield* StreamManager.StreamManager;
      const path = StreamPath.make("test/live-after");

      yield* manager.append({
        path,
        event: EventInput.make({ type: EventType.make("test"), payload: { idx: 0 } }),
      });
      yield* manager.append({
        path,
        event: EventInput.make({ type: EventType.make("test"), payload: { idx: 1 } }),
      });

      const historyReady = yield* Deferred.make<void>();
      const seenHistory = yield* Ref.make(0);
      const historyCount = 1;

      const subscriber = yield* manager
        .subscribe({ path, from: Offset.make("0000000000000000") })
        .pipe(
          Stream.tap(() =>
            Ref.updateAndGet(seenHistory, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === historyCount ? Deferred.succeed(historyReady, void 0) : Effect.void,
              ),
            ),
          ),
          Stream.take(2),
          Stream.runCollect,
          Effect.fork,
        );

      yield* Deferred.await(historyReady);

      yield* manager.append({
        path,
        event: EventInput.make({ type: EventType.make("test"), payload: { idx: 2 } }),
      });

      const events = yield* Fiber.join(subscriber);
      const arr = Chunk.toReadonlyArray(events);

      expect(arr.map((event) => event.offset)).toEqual(["0000000000000001", "0000000000000002"]);
      expect(arr.map((event) => event.payload)).toEqual([{ idx: 1 }, { idx: 2 }]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("subscribe receives history then live events", () =>
    Effect.gen(function* () {
      const manager = yield* StreamManager.StreamManager;
      const path = StreamPath.make("test/history-and-live");

      // Append historical event
      yield* manager.append({
        path,
        event: EventInput.make({ type: EventType.make("test"), payload: { kind: "historical" } }),
      });

      // Subscribe (always live = history + live)
      const subscriber = yield* manager
        .subscribe({ path })
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
