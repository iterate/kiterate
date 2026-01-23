import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Option } from "effect";

import { Offset } from "../../domain.js";
import { makeActiveRequestFiber } from "./activeRequestFiber.js";

describe("ActiveRequestFiber", () => {
  it.scoped("run returns previous offset when interrupting", () =>
    Effect.gen(function* () {
      const active = yield* makeActiveRequestFiber();
      const first = Offset.make("0000000000000001");
      const second = Offset.make("0000000000000002");
      const started = yield* Deferred.make<void>();

      // First run: long-running effect that signals when started
      const initial = yield* active.run(
        first,
        Deferred.succeed(started, void 0).pipe(Effect.andThen(Effect.never)),
      );
      expect(Option.isNone(initial)).toBe(true);

      yield* Deferred.await(started);

      // Second run interrupts first and returns previous offset
      const previous = yield* active.run(second, Effect.void);
      expect(Option.isSome(previous)).toBe(true);
      if (Option.isSome(previous)) {
        expect(previous.value).toBe(first);
      }
    }),
  );

  it.scoped("interrupts previous run when a new one starts", () =>
    Effect.gen(function* () {
      const active = yield* makeActiveRequestFiber();
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();

      const firstEffect = Effect.gen(function* () {
        yield* Deferred.succeed(started, void 0);
        return yield* Effect.never;
      }).pipe(Effect.ensuring(Deferred.succeed(interrupted, void 0)));

      yield* active.run(Offset.make("0000000000000001"), firstEffect);
      yield* Deferred.await(started);

      yield* active.run(Offset.make("0000000000000002"), Effect.void);

      yield* Deferred.await(interrupted);
    }),
  );

  it.scoped("clears the active offset when the run completes", () =>
    Effect.gen(function* () {
      const active = yield* makeActiveRequestFiber();
      const requestOffset = Offset.make("0000000000000001");
      const finished = yield* Deferred.make<void>();

      const effect = Deferred.succeed(finished, void 0);

      const waitForClear = (): Effect.Effect<void> =>
        Effect.suspend(() => {
          if (Option.isNone(active.currentOffset)) return Effect.void;
          return Effect.yieldNow().pipe(Effect.andThen(waitForClear));
        });

      yield* active.run(requestOffset, effect);
      yield* Deferred.await(finished);
      yield* Effect.yieldNow();
      yield* waitForClear();

      expect(Option.isNone(active.currentOffset)).toBe(true);
    }),
  );
});
