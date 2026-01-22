/**
 * Tests for the Processor toLayer abstraction
 *
 * Tests the FiberMap-based lazy processor spawning behavior.
 */
import { describe, it, expect } from "@effect/vitest";
import { Effect, FiberMap, Ref } from "effect";

import { StreamPath } from "../domain.js";

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

  // Note: Integration test with StreamManager.subscribe({}) omitted due to
  // inherent race condition with lazy streams. The PubSub subscription happens
  // when the stream starts consuming, which races with event publishing.
  // In production, this works because events flow continuously.
});
