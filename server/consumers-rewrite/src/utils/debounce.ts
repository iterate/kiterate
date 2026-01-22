/**
 * Debounce utility for Effect with maximum wait time
 *
 * Unlike Stream.debounce, this is for debouncing Effect executions where you want:
 * - A quiet period before execution (standard debounce)
 * - A maximum wait time to guarantee execution even under continuous triggers
 * - The most recent argument to be used when the effect finally executes
 */
import { Duration, Effect, Fiber, Option } from "effect";

/**
 * Handle returned by makeDebounced for triggering the debounced effect
 */
export interface Debounced<A, E, R, Arg> {
  /**
   * Trigger the debounced effect with the given argument.
   * - Resets the debounce timer on each call
   * - Stores the argument for when execution happens
   * - Executes after `duration` of quiet time (using the latest arg)
   * - Guarantees execution within `maxWait` of the first trigger
   *
   * Returns immediately. The actual effect runs asynchronously.
   */
  readonly trigger: (arg: Arg) => Effect.Effect<void, never, R>;

  /**
   * Wait for any pending execution to complete.
   * Returns the result if there was a pending execution, or None if nothing was pending.
   */
  readonly flush: Effect.Effect<Option.Option<A>, E, R>;

  /**
   * Cancel any pending execution without running it.
   */
  readonly cancel: Effect.Effect<void>;
}

/**
 * Options for creating a debounced effect
 */
export interface DebounceOptions {
  /** Time to wait after the last trigger before executing */
  readonly duration: Duration.DurationInput;
  /** Maximum time to wait since the first trigger (guarantees execution) */
  readonly maxWait: Duration.DurationInput;
}

/**
 * Creates a debounced wrapper around an effectful function.
 *
 * The debounced effect will:
 * - Wait for `duration` of quiet time (no new triggers) before executing
 * - Guarantee execution within `maxWait` of the first trigger, even under continuous triggers
 * - Use the most recent argument when executing
 *
 * @example
 * ```ts
 * const debounced = yield* makeDebounced(
 *   (prompt: string) => lm.streamText({ prompt }),
 *   { duration: "200 millis", maxWait: "2 seconds" }
 * )
 *
 * // These rapid triggers will be debounced, using the latest prompt
 * yield* debounced.trigger("Hello")
 * yield* debounced.trigger("Hello, how")
 * yield* debounced.trigger("Hello, how are you?")
 *
 * // streamText will be called once with "Hello, how are you?" within 2 seconds
 * ```
 */
export const makeDebounced = <A, E, R, Arg>(
  fn: (arg: Arg) => Effect.Effect<A, E, R>,
  options: DebounceOptions,
): Effect.Effect<Debounced<A, E, R, Arg>, never, R> =>
  Effect.sync(() => {
    const durationMs = Duration.toMillis(Duration.decode(options.duration));
    const maxWaitMs = Duration.toMillis(Duration.decode(options.maxWait));

    let pendingFiber: Fiber.Fiber<A, E> | null = null;
    let firstTriggerTime: number | null = null;
    let latestArg: Arg | null = null;

    const trigger = (arg: Arg): Effect.Effect<void, never, R> =>
      Effect.gen(function* () {
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);

        // Store the latest argument
        latestArg = arg;

        // Cancel any pending fiber
        if (pendingFiber !== null) {
          yield* Fiber.interrupt(pendingFiber);
        }

        // Set firstTriggerTime if this is the first trigger in the batch
        if (firstTriggerTime === null) {
          firstTriggerTime = now;
        }

        const elapsedSinceFirst = now - firstTriggerTime;
        const timeUntilMaxWait = Math.max(0, maxWaitMs - elapsedSinceFirst);
        const actualWait = Math.min(durationMs, timeUntilMaxWait);

        // Create the new delayed execution
        const delayedExecution = Effect.gen(function* () {
          if (actualWait > 0) {
            yield* Effect.sleep(Duration.millis(actualWait));
          }
          // Use the latest argument at execution time
          const result = yield* fn(latestArg as Arg);
          // Reset state after successful execution
          pendingFiber = null;
          firstTriggerTime = null;
          latestArg = null;
          return result;
        });

        // Fork the new fiber
        pendingFiber = yield* Effect.fork(delayedExecution);
      });

    const flush: Effect.Effect<Option.Option<A>, E, R> = Effect.gen(function* () {
      if (pendingFiber === null) {
        return Option.none();
      }
      const fiber = pendingFiber;
      pendingFiber = null;
      firstTriggerTime = null;
      latestArg = null;
      const result = yield* Fiber.join(fiber);
      return Option.some(result);
    });

    const cancel: Effect.Effect<void> = Effect.gen(function* () {
      if (pendingFiber !== null) {
        yield* Fiber.interrupt(pendingFiber);
      }
      pendingFiber = null;
      firstTriggerTime = null;
      latestArg = null;
    });

    return { trigger, flush, cancel };
  });
