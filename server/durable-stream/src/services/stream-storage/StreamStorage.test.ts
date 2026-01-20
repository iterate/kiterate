/**
 * StreamStorage test suite - runs against all implementations
 */
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Chunk, Effect, Layer, Stream } from "effect";

import { Offset, StreamPath } from "../../domain.js";
import * as StreamStorage from "./index.js";

/**
 * Shared test suite for StreamStorage implementations
 */
const streamStorageTests = <E>(
  name: string,
  makeLayer: () => Layer.Layer<StreamStorage.StreamStorage, E>,
) => {
  describe(name, () => {
    it.effect("append returns event with offset", () =>
      Effect.gen(function* () {
        const storage = yield* StreamStorage.StreamStorage;
        const path = StreamPath.make("test/append");

        const event = yield* storage.append({ path, payload: { message: "hello" } });

        expect(event.offset).toBe("0000000000000000");
        expect(event.payload).toEqual({ message: "hello" });
      }).pipe(Effect.provide(makeLayer())),
    );

    it.effect("append increments offset", () =>
      Effect.gen(function* () {
        const storage = yield* StreamStorage.StreamStorage;
        const path = StreamPath.make("test/increment");

        const e1 = yield* storage.append({ path, payload: { n: 1 } });
        const e2 = yield* storage.append({ path, payload: { n: 2 } });
        const e3 = yield* storage.append({ path, payload: { n: 3 } });

        expect(e1.offset).toBe("0000000000000000");
        expect(e2.offset).toBe("0000000000000001");
        expect(e3.offset).toBe("0000000000000002");
      }).pipe(Effect.provide(makeLayer())),
    );

    it.effect("read returns all stored events", () =>
      Effect.gen(function* () {
        const storage = yield* StreamStorage.StreamStorage;
        const path = StreamPath.make("test/read");

        yield* storage.append({ path, payload: { n: 1 } });
        yield* storage.append({ path, payload: { n: 2 } });
        yield* storage.append({ path, payload: { n: 3 } });

        const events = yield* storage.read({ path }).pipe(Stream.runCollect);
        const arr = Chunk.toReadonlyArray(events);

        expect(arr).toHaveLength(3);
        expect(arr.map((e) => e.payload)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
      }).pipe(Effect.provide(makeLayer())),
    );

    it.effect("read with from filters events", () =>
      Effect.gen(function* () {
        const storage = yield* StreamStorage.StreamStorage;
        const path = StreamPath.make("test/filter");

        yield* storage.append({ path, payload: { n: 0 } });
        yield* storage.append({ path, payload: { n: 1 } });
        yield* storage.append({ path, payload: { n: 2 } });

        const events = yield* storage
          .read({ path, from: Offset.make("0000000000000001") })
          .pipe(Stream.runCollect);
        const arr = Chunk.toReadonlyArray(events);

        expect(arr).toHaveLength(2);
        expect(arr.map((e) => e.offset)).toEqual(["0000000000000001", "0000000000000002"]);
        expect(arr.map((e) => e.payload)).toEqual([{ n: 1 }, { n: 2 }]);
      }).pipe(Effect.provide(makeLayer())),
    );

    it.effect("read from empty stream returns empty", () =>
      Effect.gen(function* () {
        const storage = yield* StreamStorage.StreamStorage;
        const path = StreamPath.make("test/empty");

        const events = yield* storage.read({ path }).pipe(Stream.runCollect);

        expect(Chunk.toReadonlyArray(events)).toEqual([]);
      }).pipe(Effect.provide(makeLayer())),
    );

    it.effect("different paths are independent", () =>
      Effect.gen(function* () {
        const storage = yield* StreamStorage.StreamStorage;
        const pathA = StreamPath.make("test/a");
        const pathB = StreamPath.make("test/b");

        yield* storage.append({ path: pathA, payload: { source: "A" } });
        yield* storage.append({ path: pathB, payload: { source: "B" } });

        const eventsA = yield* storage.read({ path: pathA }).pipe(Stream.runCollect);
        const eventsB = yield* storage.read({ path: pathB }).pipe(Stream.runCollect);

        expect(Chunk.toReadonlyArray(eventsA).map((e) => e.payload)).toEqual([{ source: "A" }]);
        expect(Chunk.toReadonlyArray(eventsB).map((e) => e.payload)).toEqual([{ source: "B" }]);
      }).pipe(Effect.provide(makeLayer())),
    );

    it.effect("offsets are independent per path", () =>
      Effect.gen(function* () {
        const storage = yield* StreamStorage.StreamStorage;
        const pathA = StreamPath.make("test/offset-a");
        const pathB = StreamPath.make("test/offset-b");

        const a1 = yield* storage.append({ path: pathA, payload: { n: 1 } });
        const b1 = yield* storage.append({ path: pathB, payload: { n: 1 } });
        const a2 = yield* storage.append({ path: pathA, payload: { n: 2 } });

        // Both paths start at offset 0
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
});
