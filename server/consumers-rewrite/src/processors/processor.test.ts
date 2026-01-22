/**
 * Tests for the Processor toLayer abstraction
 *
 * Tests the FiberMap-based lazy processor spawning behavior.
 * Uses it.live + Effect.scoped to avoid scope interaction issues with Effect.sleep.
 */
import { describe, it, expect } from "@effect/vitest";
import { Deferred, Effect, flow, Layer, Ref } from "effect";

import { EventInput, EventType, StreamPath } from "../domain.js";
import * as StreamManager from "../services/stream-manager/index.js";
import * as StreamStorage from "../services/stream-storage/index.js";
import { Processor, toLayer } from "./processor.js";

const TEST_TIMEOUT = "500 millis";

const baseLayer = StreamManager.liveLayer.pipe(Layer.provide(StreamStorage.inMemoryLayer));

const withTestLayer = (processor: Processor<never>) => {
  const TestLayer = Layer.merge(baseLayer, toLayer(processor).pipe(Layer.provide(baseLayer)));
  return flow(Effect.scoped, Effect.provide(TestLayer), Effect.timeout(TEST_TIMEOUT));
};

describe("Processor toLayer", () => {
  it.live("starts processor when first event arrives", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const startCount = yield* Ref.make(0);

      const processor: Processor<never> = {
        name: "start-test",
        run: () =>
          Effect.gen(function* () {
            yield* Ref.update(startCount, (n) => n + 1);
            yield* Deferred.succeed(started, void 0);
            return yield* Effect.never;
          }),
      };

      yield* Effect.gen(function* () {
        const manager = yield* StreamManager.StreamManager;

        yield* manager.append({
          path: StreamPath.make("test/start"),
          event: EventInput.make({ type: EventType.make("test"), payload: {} }),
        });

        yield* Deferred.await(started);
        expect(yield* Ref.get(startCount)).toBe(1);
      }).pipe(withTestLayer(processor));
    }),
  );

  it.live("does not start duplicate processor for same path", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const startCount = yield* Ref.make(0);

      const processor: Processor<never> = {
        name: "dedup-test",
        run: () =>
          Effect.gen(function* () {
            yield* Ref.update(startCount, (n) => n + 1);
            yield* Deferred.succeed(started, void 0);
            return yield* Effect.never;
          }),
      };

      yield* Effect.gen(function* () {
        const manager = yield* StreamManager.StreamManager;
        const path = StreamPath.make("test/dedup");
        const event = EventInput.make({ type: EventType.make("test"), payload: {} });

        // First event starts the processor
        yield* manager.append({ path, event });
        yield* Deferred.await(started);

        // More events to same path should not start new processors
        yield* manager.append({ path, event });
        yield* manager.append({ path, event });

        yield* Effect.sleep("10 millis");
        expect(yield* Ref.get(startCount)).toBe(1);
      }).pipe(withTestLayer(processor));
    }),
  );

  it.live("starts separate processors for different paths", () =>
    Effect.gen(function* () {
      const startCount = yield* Ref.make(0);
      const twoStarted = yield* Deferred.make<void>();

      const processor: Processor<never> = {
        name: "multi-path-test",
        run: () =>
          Effect.gen(function* () {
            const count = yield* Ref.updateAndGet(startCount, (n) => n + 1);
            if (count >= 2) {
              yield* Deferred.succeed(twoStarted, void 0);
            }
            return yield* Effect.never;
          }),
      };

      yield* Effect.gen(function* () {
        const manager = yield* StreamManager.StreamManager;
        const event = EventInput.make({ type: EventType.make("test"), payload: {} });

        yield* manager.append({ path: StreamPath.make("test/a"), event });
        yield* manager.append({ path: StreamPath.make("test/b"), event });

        yield* Deferred.await(twoStarted);
        expect(yield* Ref.get(startCount)).toBe(2);
      }).pipe(withTestLayer(processor));
    }),
  );
});
