/**
 * Tests for the Processor toLayer abstraction
 *
 * Tests the FiberMap-based lazy processor spawning behavior.
 * Uses it.live + Effect.scoped to avoid scope interaction issues with Effect.sleep.
 */
import { describe, it, expect } from "@effect/vitest";
import { Deferred, Effect, Layer, Ref } from "effect";

import { EventInput, EventType, StreamPath } from "../domain.js";
import * as Interceptors from "../interceptors/index.js";
import * as StreamManager from "../services/stream-manager/index.js";
import * as StreamStorage from "../services/stream-storage/index.js";
import { toLayer, type Processor } from "./processor.js";

const TEST_TIMEOUT = "500 millis";
const streamManagerLayer = StreamManager.liveLayer.pipe(
  Layer.provide(StreamStorage.inMemoryLayer),
  Layer.provide(Interceptors.emptyLayer),
);
const testEventType = EventType.make("test");

const makeTestLayer = (processor: Processor<never>) =>
  Layer.merge(streamManagerLayer, toLayer(processor).pipe(Layer.provide(streamManagerLayer)));

const withTestLayer =
  (processor: Processor<never>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.scoped,
      Effect.provide(makeTestLayer(processor)),
      Effect.timeout(TEST_TIMEOUT),
    );

const makeTestEvent = () => EventInput.make({ type: testEventType, payload: {} });

const makeCountingProcessor = (
  name: string,
  startCount: Ref.Ref<number>,
  onStart: (count: number) => Effect.Effect<void>,
): Processor<never> => ({
  name,
  run: () =>
    Effect.gen(function* () {
      const count = yield* Ref.updateAndGet(startCount, (n) => n + 1);
      yield* onStart(count);
      return yield* Effect.never;
    }),
});

describe("Processor toLayer", () => {
  it.live("starts processor when first event arrives", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const startCount = yield* Ref.make(0);

      const processor = makeCountingProcessor("start-test", startCount, () =>
        Deferred.succeed(started, void 0),
      );

      yield* Effect.gen(function* () {
        const manager = yield* StreamManager.StreamManager;

        yield* manager.append({
          path: StreamPath.make("test/start"),
          event: makeTestEvent(),
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

      const processor = makeCountingProcessor("dedup-test", startCount, () =>
        Deferred.succeed(started, void 0),
      );

      yield* Effect.gen(function* () {
        const manager = yield* StreamManager.StreamManager;
        const path = StreamPath.make("test/dedup");
        const event = makeTestEvent();

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

      const processor = makeCountingProcessor("multi-path-test", startCount, (count) =>
        count >= 2 ? Deferred.succeed(twoStarted, void 0) : Effect.void,
      );

      yield* Effect.gen(function* () {
        const manager = yield* StreamManager.StreamManager;
        const event = makeTestEvent();

        yield* manager.append({ path: StreamPath.make("test/a"), event });
        yield* manager.append({ path: StreamPath.make("test/b"), event });

        yield* Deferred.await(twoStarted);
        expect(yield* Ref.get(startCount)).toBe(2);
      }).pipe(withTestLayer(processor));
    }),
  );
});
