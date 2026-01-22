/**
 * Processor Abstraction
 *
 * A minimal interface for building path-scoped processors. Each processor's `run`
 * is called once per path, with a path-scoped EventStream.
 */
import { Effect, Layer, Scope, Stream } from "effect";

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
 * Spawns a processor for each path that has events.
 */
export const toLayer = <R>(
  processor: Processor<R>,
): Layer.Layer<never, never, StreamManager | Exclude<R, Scope.Scope>> =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const streamManager = yield* StreamManager;
      const context = yield* Effect.context<Exclude<R, Scope.Scope>>();

      // Track which paths we've started processors for
      const activePaths = new Set<StreamPath>();

      const makeStream = (path: StreamPath): EventStream.EventStream => ({
        subscribe: (options) =>
          streamManager.subscribe({
            path,
            ...(options?.from !== undefined && { from: options.from }),
          }),

        read: (options) =>
          streamManager.read({
            path,
            ...(options?.from !== undefined && { from: options.from }),
            ...(options?.to !== undefined && { to: options.to }),
          }),

        append: (event) => streamManager.append({ path, event }),
      });

      const startProcessor = (path: StreamPath) =>
        Effect.gen(function* () {
          if (activePaths.has(path)) return;
          activePaths.add(path);

          yield* Effect.log(`starting for path=${path}`);

          const stream = makeStream(path);
          yield* processor.run(stream).pipe(
            Effect.provide(context),
            Effect.catchAllCause((cause) => Effect.logError(`error on path=${path}`, cause)),
            Effect.forkScoped,
          );
        });

      yield* Effect.log("starting");

      // Discover existing paths and start processors
      yield* streamManager.read({}).pipe(
        Stream.runForEach((event) => startProcessor(event.path)),
        Effect.catchAllCause((cause) => Effect.logError("discovery failed", cause)),
      );

      yield* Effect.log(`discovered ${activePaths.size} paths`);

      // Watch for new paths
      yield* streamManager.subscribe({}).pipe(
        Stream.runForEach((event) => startProcessor(event.path)),
        Effect.catchAllCause((cause) => Effect.logError("watch failed", cause)),
        Effect.forkScoped,
      );
    }).pipe(Effect.annotateLogs("processor", processor.name)),
  );
