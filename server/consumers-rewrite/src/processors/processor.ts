/**
 * Processor Abstraction
 *
 * A minimal interface for building path-scoped processors. Each processor's `run`
 * is called once per path, with a path-scoped ProcessorStream.
 */
import { Effect, Layer, Scope, Stream } from "effect";

import { Event, EventInput, Offset, StreamPath } from "../domain.js";
import { StreamManager } from "../services/stream-manager/index.js";

// -------------------------------------------------------------------------------------
// ProcessorStream
// -------------------------------------------------------------------------------------

/**
 * A path-scoped stream interface for processors.
 */
export interface ProcessorStream {
  /** The path this stream is scoped to */
  readonly path: StreamPath;

  /** Subscribe to live events on this path, optionally starting after an offset */
  readonly subscribe: (options?: { from?: Offset }) => Stream.Stream<Event>;

  /** Read historical events on this path, optionally within a range */
  readonly read: (options?: { from?: Offset; to?: Offset }) => Stream.Stream<Event>;

  /** Append an event to this path, returns the assigned offset */
  readonly append: (event: EventInput) => Effect.Effect<Offset>;
}

// -------------------------------------------------------------------------------------
// Processor
// -------------------------------------------------------------------------------------

/**
 * A processor - a function that runs per-path with a path-scoped ProcessorStream.
 */
export interface Processor<R> {
  readonly name: string;
  readonly run: (stream: ProcessorStream) => Effect.Effect<void, never, R | Scope.Scope>;
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

      const makeStream = (path: StreamPath): ProcessorStream => ({
        path,

        subscribe: (options) =>
          streamManager
            .subscribe({
              path,
              live: true,
              ...(options?.from !== undefined && { after: options.from }),
            })
            .pipe(Stream.catchAllCause(() => Stream.empty)),

        read: (options) =>
          streamManager
            .subscribe({
              path,
              live: false,
              ...(options?.from !== undefined && { after: options.from }),
              // Note: 'to' not currently supported by StreamManager
            })
            .pipe(Stream.catchAllCause(() => Stream.empty)),

        append: (event) =>
          streamManager.append({ path, event }).pipe(
            Effect.map((e) => e.offset),
            Effect.catchAllCause((cause) =>
              Effect.gen(function* () {
                yield* Effect.logError("append failed", cause);
                return Offset.make("-1"); // fallback offset on error
              }),
            ),
          ),
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
      yield* streamManager.subscribe({ live: false }).pipe(
        Stream.runForEach((event) => startProcessor(event.path)),
        Effect.catchAllCause((cause) => Effect.logError("discovery failed", cause)),
      );

      yield* Effect.log(`discovered ${activePaths.size} paths`);

      // Watch for new paths
      yield* streamManager.subscribe({ live: true }).pipe(
        Stream.runForEach((event) => startProcessor(event.path)),
        Effect.catchAllCause((cause) => Effect.logError("watch failed", cause)),
        Effect.forkScoped,
      );
    }).pipe(Effect.annotateLogs("processor", processor.name)),
  );
