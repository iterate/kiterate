import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Option, Ref, TestClock } from "effect";

import { makeDebounced } from "./debounce.js";

describe("Debounce", () => {
  it.effect("executes effect after duration of quiet time", () =>
    Effect.gen(function* () {
      const callCount = yield* Ref.make(0);

      const debounced = yield* makeDebounced((_: void) => Ref.update(callCount, (n) => n + 1), {
        duration: "100 millis",
        maxWait: "1 second",
      });

      yield* debounced.trigger(undefined);

      // Not yet executed
      expect(yield* Ref.get(callCount)).toBe(0);

      // Advance past duration
      yield* TestClock.adjust(Duration.millis(100));

      // Now executed
      expect(yield* Ref.get(callCount)).toBe(1);
    }),
  );

  it.effect("resets timer on each trigger (debouncing)", () =>
    Effect.gen(function* () {
      const callCount = yield* Ref.make(0);

      const debounced = yield* makeDebounced((_: void) => Ref.update(callCount, (n) => n + 1), {
        duration: "100 millis",
        maxWait: "1 second",
      });

      yield* debounced.trigger(undefined);
      yield* TestClock.adjust(Duration.millis(50));

      // Trigger again before duration expires
      yield* debounced.trigger(undefined);
      yield* TestClock.adjust(Duration.millis(50));

      // Still not executed (timer reset)
      expect(yield* Ref.get(callCount)).toBe(0);

      // Trigger again
      yield* debounced.trigger(undefined);
      yield* TestClock.adjust(Duration.millis(100));

      // Now executed (100ms since last trigger)
      expect(yield* Ref.get(callCount)).toBe(1);
    }),
  );

  it.effect("executes at maxWait even under continuous triggers", () =>
    Effect.gen(function* () {
      const callCount = yield* Ref.make(0);

      const debounced = yield* makeDebounced((_: void) => Ref.update(callCount, (n) => n + 1), {
        duration: "100 millis",
        maxWait: "250 millis",
      });

      // Trigger continuously, never giving 100ms of quiet time
      yield* debounced.trigger(undefined);
      yield* TestClock.adjust(Duration.millis(50));
      expect(yield* Ref.get(callCount)).toBe(0);

      yield* debounced.trigger(undefined);
      yield* TestClock.adjust(Duration.millis(50));
      expect(yield* Ref.get(callCount)).toBe(0);

      yield* debounced.trigger(undefined);
      yield* TestClock.adjust(Duration.millis(50));
      expect(yield* Ref.get(callCount)).toBe(0);

      yield* debounced.trigger(undefined);
      yield* TestClock.adjust(Duration.millis(50));
      expect(yield* Ref.get(callCount)).toBe(0);

      // Now at 200ms since first trigger, trigger again
      yield* debounced.trigger(undefined);
      // maxWait is 250ms, we're at 200ms, so only 50ms remaining
      // But duration is 100ms, so actualWait = min(100, 50) = 50ms
      yield* TestClock.adjust(Duration.millis(50));

      // Should have executed (maxWait reached)
      expect(yield* Ref.get(callCount)).toBe(1);
    }),
  );

  it.effect("shortens wait time as maxWait approaches", () =>
    Effect.gen(function* () {
      const callCount = yield* Ref.make(0);

      const debounced = yield* makeDebounced((_: void) => Ref.update(callCount, (n) => n + 1), {
        duration: "100 millis",
        maxWait: "150 millis",
      });

      // t=0: trigger, actualWait = min(100, 150) = 100
      yield* debounced.trigger(undefined);
      yield* TestClock.adjust(Duration.millis(50));
      expect(yield* Ref.get(callCount)).toBe(0);

      // t=50: trigger resets timer, actualWait = min(100, 100) = 100
      yield* debounced.trigger(undefined);
      yield* TestClock.adjust(Duration.millis(50));
      expect(yield* Ref.get(callCount)).toBe(0);

      // t=100: trigger resets timer, but actualWait = min(100, 50) = 50
      yield* debounced.trigger(undefined);

      // After 50ms (at t=150), should execute because actualWait was shortened
      yield* TestClock.adjust(Duration.millis(50));
      expect(yield* Ref.get(callCount)).toBe(1);
    }),
  );

  it.effect("resets maxWait timer after execution", () =>
    Effect.gen(function* () {
      const callCount = yield* Ref.make(0);

      const debounced = yield* makeDebounced((_: void) => Ref.update(callCount, (n) => n + 1), {
        duration: "50 millis",
        maxWait: "100 millis",
      });

      // First batch
      yield* debounced.trigger(undefined);
      yield* TestClock.adjust(Duration.millis(50));
      expect(yield* Ref.get(callCount)).toBe(1);

      // Second batch - maxWait should be fresh
      yield* debounced.trigger(undefined);
      yield* TestClock.adjust(Duration.millis(30));
      yield* debounced.trigger(undefined);
      yield* TestClock.adjust(Duration.millis(30));
      yield* debounced.trigger(undefined);
      yield* TestClock.adjust(Duration.millis(50));

      // Should execute after duration (not immediately due to previous maxWait)
      expect(yield* Ref.get(callCount)).toBe(2);
    }),
  );

  it.effect("flush waits for pending execution", () =>
    Effect.gen(function* () {
      const callCount = yield* Ref.make(0);

      const debounced = yield* makeDebounced(
        (_: void) =>
          Effect.gen(function* () {
            yield* Ref.update(callCount, (n) => n + 1);
            return "done";
          }),
        { duration: "100 millis", maxWait: "1 second" },
      );

      yield* debounced.trigger(undefined);

      // Flush in a forked fiber (it will block waiting for the debounce)
      const flushFiber = yield* Effect.fork(debounced.flush);

      // Advance time to let debounce execute
      yield* TestClock.adjust(Duration.millis(100));

      const result = yield* Effect.fromFiber(flushFiber);
      expect(result).toEqual(Option.some("done"));
      expect(yield* Ref.get(callCount)).toBe(1);
    }),
  );

  it.effect("flush returns None when nothing pending", () =>
    Effect.gen(function* () {
      const debounced = yield* makeDebounced((_: void) => Effect.succeed("result"), {
        duration: "100 millis",
        maxWait: "1 second",
      });

      const result = yield* debounced.flush;
      expect(result).toEqual(Option.none());
    }),
  );

  it.effect("cancel prevents pending execution", () =>
    Effect.gen(function* () {
      const callCount = yield* Ref.make(0);

      const debounced = yield* makeDebounced((_: void) => Ref.update(callCount, (n) => n + 1), {
        duration: "100 millis",
        maxWait: "1 second",
      });

      yield* debounced.trigger(undefined);
      yield* TestClock.adjust(Duration.millis(50));

      yield* debounced.cancel;

      yield* TestClock.adjust(Duration.millis(100));

      // Should not have executed
      expect(yield* Ref.get(callCount)).toBe(0);
    }),
  );

  it.effect("can trigger again after cancel", () =>
    Effect.gen(function* () {
      const callCount = yield* Ref.make(0);

      const debounced = yield* makeDebounced((_: void) => Ref.update(callCount, (n) => n + 1), {
        duration: "100 millis",
        maxWait: "1 second",
      });

      yield* debounced.trigger(undefined);
      yield* debounced.cancel;

      yield* debounced.trigger(undefined);
      yield* TestClock.adjust(Duration.millis(100));

      expect(yield* Ref.get(callCount)).toBe(1);
    }),
  );

  it.effect("multiple rapid triggers only execute once", () =>
    Effect.gen(function* () {
      const callCount = yield* Ref.make(0);

      const debounced = yield* makeDebounced((_: void) => Ref.update(callCount, (n) => n + 1), {
        duration: "100 millis",
        maxWait: "1 second",
      });

      // Rapid fire triggers
      yield* debounced.trigger(undefined);
      yield* debounced.trigger(undefined);
      yield* debounced.trigger(undefined);
      yield* debounced.trigger(undefined);
      yield* debounced.trigger(undefined);

      yield* TestClock.adjust(Duration.millis(100));

      // Should only execute once
      expect(yield* Ref.get(callCount)).toBe(1);
    }),
  );

  it.effect("uses the latest argument when executing", () =>
    Effect.gen(function* () {
      const lastArg = yield* Ref.make<string | null>(null);

      const debounced = yield* makeDebounced((arg: string) => Ref.set(lastArg, arg), {
        duration: "100 millis",
        maxWait: "1 second",
      });

      yield* debounced.trigger("first");
      yield* debounced.trigger("second");
      yield* debounced.trigger("third");

      yield* TestClock.adjust(Duration.millis(100));

      // Should have used the latest argument
      expect(yield* Ref.get(lastArg)).toBe("third");
    }),
  );

  it.effect("uses latest argument even when maxWait forces execution", () =>
    Effect.gen(function* () {
      const lastArg = yield* Ref.make<string | null>(null);

      const debounced = yield* makeDebounced((arg: string) => Ref.set(lastArg, arg), {
        duration: "100 millis",
        maxWait: "150 millis",
      });

      yield* debounced.trigger("first");
      yield* TestClock.adjust(Duration.millis(50));

      yield* debounced.trigger("second");
      yield* TestClock.adjust(Duration.millis(50));

      yield* debounced.trigger("third");
      yield* TestClock.adjust(Duration.millis(50));

      // maxWait triggered execution
      expect(yield* Ref.get(lastArg)).toBe("third");
    }),
  );
});
