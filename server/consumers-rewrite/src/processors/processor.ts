/**
 * Processor Abstraction
 *
 * A minimal interface for building path-scoped processors. Each processor's `run`
 * is called once per path, with a path-scoped EventStream.
 *
 * Processors are started lazily - when the first event for a path arrives via
 * subscribe({}), a processor is spawned for that path. The processor then uses
 * its EventStream to read history and subscribe to live events.
 */
import { Deferred, Effect, FiberMap, Layer, Scope, Stream } from "effect";

import { StreamPath } from "../domain.js";
import { EventStream, StreamManager } from "../services/stream-manager/index.js";

// -------------------------------------------------------------------------------------
// Processor
// -------------------------------------------------------------------------------------

/**
 * A processor - a function that runs per-path with a path-scoped EventStream.
 */
export interface Processor<R> {
  readonly name: string;
  readonly run: (stream: EventStream.EventStream) => Effect.Effect<void, never, R | Scope.Scope>;
}

// -------------------------------------------------------------------------------------
// Layer Construction
// -------------------------------------------------------------------------------------

/**
 * Convert a Processor into a Layer.
 *
 * Spawns a processor lazily for each path when the first event arrives.
 * Uses FiberMap to track active processors and prevent duplicates.
 */
export const toLayer = <R>(
  processor: Processor<R>,
): Layer.Layer<never, never, StreamManager | Exclude<R, Scope.Scope>> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const streamManager = yield* StreamManager;
      const context = yield* Effect.context<Exclude<R, Scope.Scope>>();
      const processors = yield* FiberMap.make<StreamPath>();
      const started = yield* Deferred.make<void>();

      yield* Effect.log("starting");

      // Watch for events and start processors lazily
      yield* streamManager.subscribe({}).pipe(
        Stream.onStart(Deferred.succeed(started, void 0)),
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const stream = yield* streamManager.forPath(event.path);
            yield* FiberMap.run(
              processors,
              event.path,
              processor.run(stream).pipe(
                Effect.provide(context),
                Effect.catchAllCause((cause) =>
                  Effect.logError(`error on path=${event.path}`, cause),
                ),
              ),
              { onlyIfMissing: true },
            );
          }),
        ),
        Effect.catchAllCause((cause) => Effect.logError("watch failed", cause)),
        Effect.forkScoped,
      );

      // Ensure subscription is active before returning (useful for tests)
      yield* Deferred.await(started);
    }).pipe(Effect.annotateLogs("processor", processor.name)),
  );
