/**
 * StreamStorage test suite - runs against all implementations
 *
 * Note: Storage is "dumb" - it just persists Event objects with offset already assigned.
 * Offset management is handled by EventStream, not storage.
 */
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Chunk, DateTime, Effect, Layer, Option, Stream } from "effect";

import { Event, EventType, Offset, StreamPath } from "../../domain.js";
import { SpanId, TraceContext, TraceId } from "../../tracing/traceContext.js";
import * as StreamStorage from "./index.js";

/** Counter for generating unique span IDs in tests */
let testSpanCounter = 0;

/** Helper to create a full Event with all required fields */
const makeEvent = (
  path: StreamPath,
  offset: number,
  payload: Record<string, unknown>,
): Effect.Effect<Event, never, never> =>
  Effect.gen(function* () {
    const createdAt = yield* DateTime.now;
    return Event.make({
      type: EventType.make("test"),
      payload,
      path,
      offset: Offset.make(offset.toString().padStart(16, "0")),
      createdAt,
      trace: TraceContext.make({
        traceId: TraceId.make(`test-trace-${path}`),
        spanId: SpanId.make(`test-span-${testSpanCounter++}`),
        parentSpanId: Option.none(),
      }),
    });
  });

/**
 * Shared test suite for StreamStorage implementations
 */
const streamStorageTests = <E>(
  name: string,
  makeLayer: () => Layer.Layer<StreamStorage.StreamStorageManager, E>,
) => {
  describe(name, () => {
    it.effect("append stores and returns the event", () =>
      Effect.gen(function* () {
        const storage = yield* StreamStorage.StreamStorageManager;
        const path = StreamPath.make("test/append");

        const event = yield* makeEvent(path, 0, { message: "hello" });
        const stored = yield* storage.append(event);

        expect(stored.offset).toBe("0000000000000000");
        expect(stored.payload).toEqual({ message: "hello" });
      }).pipe(Effect.provide(makeLayer())),
    );

    it.effect("append stores multiple events with given offsets", () =>
      Effect.gen(function* () {
        const storage = yield* StreamStorage.StreamStorageManager;
        const path = StreamPath.make("test/increment");

        const e1 = yield* makeEvent(path, 0, { n: 1 });
        const e2 = yield* makeEvent(path, 1, { n: 2 });
        const e3 = yield* makeEvent(path, 2, { n: 3 });

        const s1 = yield* storage.append(e1);
        const s2 = yield* storage.append(e2);
        const s3 = yield* storage.append(e3);

        expect(s1.offset).toBe("0000000000000000");
        expect(s2.offset).toBe("0000000000000001");
        expect(s3.offset).toBe("0000000000000002");
      }).pipe(Effect.provide(makeLayer())),
    );

    it.effect("listPaths returns empty when no streams", () =>
      Effect.gen(function* () {
        const storage = yield* StreamStorage.StreamStorageManager;

        const paths = yield* storage.listPaths();

        expect(paths).toEqual([]);
      }).pipe(Effect.provide(makeLayer())),
    );

    it.effect("listPaths returns unique paths", () =>
      Effect.gen(function* () {
        const storage = yield* StreamStorage.StreamStorageManager;
        const pathA = StreamPath.make("test/list/a");
        const pathB = StreamPath.make("test/list/b");

        yield* storage.append(yield* makeEvent(pathA, 0, { n: 1 }));
        yield* storage.append(yield* makeEvent(pathA, 1, { n: 2 }));
        yield* storage.append(yield* makeEvent(pathB, 0, { n: 3 }));

        const paths = yield* storage.listPaths();

        expect(paths).toHaveLength(2);
        expect(new Set(paths).size).toBe(2);
        expect(paths).toEqual(expect.arrayContaining([pathA, pathB]));
      }).pipe(Effect.provide(makeLayer())),
    );

    it.effect("read returns all stored events", () =>
      Effect.gen(function* () {
        const storage = yield* StreamStorage.StreamStorageManager;
        const path = StreamPath.make("test/read");

        yield* storage.append(yield* makeEvent(path, 0, { n: 1 }));
        yield* storage.append(yield* makeEvent(path, 1, { n: 2 }));
        yield* storage.append(yield* makeEvent(path, 2, { n: 3 }));

        const events = yield* storage.read({ path }).pipe(Stream.runCollect);
        const arr = Chunk.toReadonlyArray(events);

        expect(arr).toHaveLength(3);
        expect(arr.map((e) => e.payload)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
      }).pipe(Effect.provide(makeLayer())),
    );

    it.effect("read with from filters events (exclusive - returns events after from)", () =>
      Effect.gen(function* () {
        const storage = yield* StreamStorage.StreamStorageManager;
        const path = StreamPath.make("test/filter");

        yield* storage.append(yield* makeEvent(path, 0, { n: 0 }));
        yield* storage.append(yield* makeEvent(path, 1, { n: 1 }));
        yield* storage.append(yield* makeEvent(path, 2, { n: 2 }));

        // from="0000000000000001" means "I've seen offset 1, give me what's after"
        const events = yield* storage
          .read({ path, from: Offset.make("0000000000000001") })
          .pipe(Stream.runCollect);
        const arr = Chunk.toReadonlyArray(events);

        // Should only get offset 2 (after offset 1)
        expect(arr).toHaveLength(1);
        expect(arr.map((e) => e.offset)).toEqual(["0000000000000002"]);
        expect(arr.map((e) => e.payload)).toEqual([{ n: 2 }]);
      }).pipe(Effect.provide(makeLayer())),
    );

    it.effect("read after beyond last offset returns empty", () =>
      Effect.gen(function* () {
        const storage = yield* StreamStorage.StreamStorageManager;
        const path = StreamPath.make("test/after-last");

        yield* storage.append(yield* makeEvent(path, 0, { n: 1 }));
        yield* storage.append(yield* makeEvent(path, 1, { n: 2 }));

        const events = yield* storage
          .read({ path, from: Offset.make("0000000000000009") })
          .pipe(Stream.runCollect);

        expect(Chunk.toReadonlyArray(events)).toEqual([]);
      }).pipe(Effect.provide(makeLayer())),
    );

    it.effect("read from empty stream returns empty", () =>
      Effect.gen(function* () {
        const storage = yield* StreamStorage.StreamStorageManager;
        const path = StreamPath.make("test/empty");

        const events = yield* storage.read({ path }).pipe(Stream.runCollect);

        expect(Chunk.toReadonlyArray(events)).toEqual([]);
      }).pipe(Effect.provide(makeLayer())),
    );

    it.effect("different paths are independent", () =>
      Effect.gen(function* () {
        const storage = yield* StreamStorage.StreamStorageManager;
        const pathA = StreamPath.make("test/a");
        const pathB = StreamPath.make("test/b");

        yield* storage.append(yield* makeEvent(pathA, 0, { source: "A" }));
        yield* storage.append(yield* makeEvent(pathB, 0, { source: "B" }));

        const eventsA = yield* storage.read({ path: pathA }).pipe(Stream.runCollect);
        const eventsB = yield* storage.read({ path: pathB }).pipe(Stream.runCollect);

        expect(Chunk.toReadonlyArray(eventsA).map((e) => e.payload)).toEqual([{ source: "A" }]);
        expect(Chunk.toReadonlyArray(eventsB).map((e) => e.payload)).toEqual([{ source: "B" }]);
      }).pipe(Effect.provide(makeLayer())),
    );

    it.effect("stores events with their given offsets", () =>
      Effect.gen(function* () {
        const storage = yield* StreamStorage.StreamStorageManager;
        const pathA = StreamPath.make("test/offset-a");
        const pathB = StreamPath.make("test/offset-b");

        const a1 = yield* storage.append(yield* makeEvent(pathA, 0, { n: 1 }));
        const b1 = yield* storage.append(yield* makeEvent(pathB, 0, { n: 1 }));
        const a2 = yield* storage.append(yield* makeEvent(pathA, 1, { n: 2 }));

        // Offsets are preserved as passed in
        expect(a1.offset).toBe("0000000000000000");
        expect(b1.offset).toBe("0000000000000000");
        expect(a2.offset).toBe("0000000000000001");
      }).pipe(Effect.provide(makeLayer())),
    );
  });
};

// -------------------------------------------------------------------------------------
// Run tests for each implementation
// -------------------------------------------------------------------------------------

describe("StreamStorage", () => {
  // In-memory implementation
  streamStorageTests("InMemory", () => StreamStorage.inMemoryLayer);

  // FileSystem implementation - uses scoped temp directory that auto-cleans
  const fileSystemTestLayer = Layer.unwrapScoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped();
      return StreamStorage.fileSystemLayer(tempDir);
    }),
  ).pipe(Layer.provide(NodeContext.layer));

  streamStorageTests("FileSystem", () => fileSystemTestLayer);

  // SQLite implementation - uses scoped temp file that auto-cleans
  const sqliteTestLayer = Layer.unwrapScoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped();
      return StreamStorage.sqliteLayer(`${tempDir}/test.db`);
    }),
  ).pipe(Layer.provide(NodeContext.layer));

  streamStorageTests("SQLite", () => sqliteTestLayer);
});
