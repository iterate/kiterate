/**
 * Tests for the Processor toLayer abstraction
 *
 * Tests the FiberMap-based lazy processor spawning behavior.
 */
import { describe, it, expect } from "@effect/vitest";
import { Context, Deferred, Effect, FiberMap, Layer, Ref } from "effect";

import { EventInput, EventType, StreamPath } from "../domain.js";
import * as StreamManager from "../services/stream-manager/index.js";
import * as StreamStorage from "../services/stream-storage/index.js";
import { toLayer } from "./processor.js";

describe("Processor toLayer", () => {
  it.scoped("FiberMap.run with onlyIfMissing prevents duplicate processors", () =>
    Effect.gen(function* () {
      const startCount = yield* Ref.make(0);
      const processors = yield* FiberMap.make<StreamPath>();

      const runProcessor = (path: StreamPath) =>
        FiberMap.run(
          processors,
          path,
          Effect.gen(function* () {
            yield* Ref.update(startCount, (n) => n + 1);
            return yield* Effect.never;
          }),
          { onlyIfMissing: true },
        );

      const path = StreamPath.make("test/dedup");

      // Run multiple times for same path
      yield* runProcessor(path);
      yield* runProcessor(path);
      yield* runProcessor(path);

      // Should only have started once
      const starts = yield* Ref.get(startCount);
      expect(starts).toBe(1);
    }),
  );

  it.scoped("FiberMap.run spawns separate fibers for different keys", () =>
    Effect.gen(function* () {
      const startedPaths = yield* Ref.make<readonly StreamPath[]>([]);
      const processors = yield* FiberMap.make<StreamPath>();

      const runProcessor = (path: StreamPath) =>
        FiberMap.run(
          processors,
          path,
          Effect.gen(function* () {
            yield* Ref.update(startedPaths, (paths) => [...paths, path]);
            return yield* Effect.never;
          }),
          { onlyIfMissing: true },
        );

      const pathA = StreamPath.make("test/multi/a");
      const pathB = StreamPath.make("test/multi/b");

      yield* runProcessor(pathA);
      yield* runProcessor(pathB);

      const paths = yield* Ref.get(startedPaths);
      expect(paths).toHaveLength(2);
      expect(paths).toContain(pathA);
      expect(paths).toContain(pathB);
    }),
  );

  it.scoped("toLayer starts processor after subscription is active", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const startCount = yield* Ref.make(0);

      const processor = {
        name: "test-processor",
        run: (_stream: StreamManager.EventStream.EventStream) =>
          Effect.gen(function* () {
            const count = yield* Ref.updateAndGet(startCount, (n) => n + 1);
            if (count === 1) {
              yield* Deferred.succeed(started, void 0);
            }
            return yield* Effect.never;
          }),
      };

      const streamManagerLayer = StreamManager.liveLayer.pipe(
        Layer.provide(StreamStorage.inMemoryLayer),
      );

      const processorLayer = toLayer(processor).pipe(Layer.provide(streamManagerLayer));

      const appLayer = Layer.merge(streamManagerLayer, processorLayer);
      const env = yield* Layer.build(appLayer);
      const manager = Context.get(env, StreamManager.StreamManager);

      yield* manager.append({
        path: StreamPath.make("test/ready"),
        event: EventInput.make({ type: EventType.make("test"), payload: { ok: true } }),
      });

      yield* Deferred.await(started);

      const count = yield* Ref.get(startCount);
      expect(count).toBe(1);
    }),
  );
});
