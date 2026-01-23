import { Effect, FiberMap, Option, type Scope } from "effect";

import { Offset } from "../../domain.js";

export type ActiveRequestFiber = {
  /** Run effect as the active request, interrupting any previous. Returns previous offset if any. */
  readonly run: <R>(
    requestOffset: Offset,
    effect: Effect.Effect<void, never, R>,
  ) => Effect.Effect<Option.Option<Offset>, never, R>;
  /** Interrupt the current request without starting a new one */
  readonly interruptOnly: () => Effect.Effect<void>;
  readonly currentOffset: Option.Option<Offset>;
};

export const makeActiveRequestFiber = (): Effect.Effect<ActiveRequestFiber, never, Scope.Scope> =>
  Effect.gen(function* () {
    const map = yield* FiberMap.make<"active", void>();
    let currentOffset: Option.Option<Offset> = Option.none();

    const clearIfActive = (requestOffset: Offset) =>
      Effect.sync(() => {
        if (Option.isSome(currentOffset) && currentOffset.value === requestOffset) {
          currentOffset = Option.none();
        }
      });

    const run = <R>(requestOffset: Offset, effect: Effect.Effect<void, never, R>) =>
      Effect.gen(function* () {
        const previous = currentOffset;
        currentOffset = Option.some(requestOffset);
        yield* FiberMap.run(
          map,
          "active",
          effect.pipe(Effect.ensuring(clearIfActive(requestOffset))),
          {
            propagateInterruption: true,
          },
        );
        return previous;
      });

    const interruptOnly = () =>
      Effect.gen(function* () {
        yield* FiberMap.clear(map);
        currentOffset = Option.none();
      });

    return {
      run,
      interruptOnly,
      get currentOffset() {
        return currentOffset;
      },
    };
  });
