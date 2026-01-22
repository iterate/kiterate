/**
 * Live implementation of StreamManager
 */
import { Effect, Layer, PubSub, Stream, SynchronizedRef } from "effect";

import { Event, EventInput, Offset, StreamPath } from "../../domain.js";
import { StreamStorageManager } from "../stream-storage/service.js";
import * as EventStream from "./eventStream.js";
import { StreamManager } from "./service.js";

// -------------------------------------------------------------------------------------
// StreamManager layer
// -------------------------------------------------------------------------------------

export const liveLayer: Layer.Layer<StreamManager, never, StreamStorageManager> = Layer.effect(
  StreamManager,
  Effect.gen(function* () {
    const storageManager = yield* StreamStorageManager;
    const streamsRef = yield* SynchronizedRef.make(new Map<StreamPath, EventStream.EventStream>());

    // Global PubSub for all events (used for "all paths" subscriptions)
    const globalPubSub = yield* PubSub.unbounded<Event>();

    const getOrCreateStream = Effect.fn("StreamManager.getOrCreateStream")(function* (
      path: StreamPath,
    ) {
      return yield* SynchronizedRef.modifyEffect(streamsRef, (streams) => {
        const existing = streams.get(path);
        if (existing) {
          const result: readonly [
            EventStream.EventStream,
            Map<StreamPath, EventStream.EventStream>,
          ] = [existing, streams];
          return Effect.succeed(result);
        }

        // Create path-scoped storage and wrap with EventStream
        const storage = storageManager.forPath(path);
        return EventStream.make(storage).pipe(
          Effect.map((stream) => {
            streams.set(path, stream);
            const result: readonly [
              EventStream.EventStream,
              Map<StreamPath, EventStream.EventStream>,
            ] = [stream, streams];
            return result;
          }),
        );
      });
    });

    const forPath = (path: StreamPath) => getOrCreateStream(path);

    const append = Effect.fn("StreamManager.append")(function* ({
      path,
      event,
    }: {
      path: StreamPath;
      event: EventInput;
    }) {
      const stream = yield* getOrCreateStream(path);
      const storedEvent = yield* stream.append(event);

      // Also publish to global PubSub for "all paths" subscribers
      yield* PubSub.publish(globalPubSub, storedEvent);

      return storedEvent;
    });

    const subscribe = ({ path, from }: { path?: StreamPath; from?: Offset }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (path !== undefined) {
            // Single path subscription
            const stream = yield* getOrCreateStream(path);
            return stream.subscribe({ ...(from !== undefined && { from }) });
          }

          // All paths subscription - history + global PubSub for new events
          const afterOffset = from ?? Offset.make("-1");
          const existingPaths = yield* storageManager.listPaths();

          return Stream.unwrapScoped(
            Effect.gen(function* () {
              // Subscribe to global PubSub first (don't miss events during history replay)
              const queue = yield* PubSub.subscribe(globalPubSub);
              const liveStream = Stream.fromQueue(queue);

              // Read historical from storage for each path
              const historicalStream =
                existingPaths.length > 0
                  ? Stream.mergeAll(
                      existingPaths.map((p) => storageManager.read({ path: p, from: afterOffset })),
                      { concurrency: "unbounded" },
                    )
                  : Stream.empty;

              // Track last seen offset PER PATH for deduplication (offsets are path-local)
              const lastOffsetByPath = new Map<StreamPath, Offset>();
              existingPaths.forEach((p) => lastOffsetByPath.set(p, afterOffset));

              const trackedHistorical = historicalStream.pipe(
                Stream.tap((event) =>
                  Effect.sync(() => lastOffsetByPath.set(event.path, event.offset)),
                ),
              );

              const dedupedLive = liveStream.pipe(
                Stream.filter((event) => {
                  const lastOffset = lastOffsetByPath.get(event.path) ?? Offset.make("-1");
                  if (Offset.gt(event.offset, lastOffset)) {
                    lastOffsetByPath.set(event.path, event.offset);
                    return true;
                  }
                  return false;
                }),
              );

              return Stream.concat(trackedHistorical, dedupedLive);
            }),
          );
        }).pipe(Effect.withSpan("StreamManager.subscribe")),
      ).pipe(Stream.catchAllCause(() => Stream.empty));

    const read = ({ path, from, to }: { path?: StreamPath; from?: Offset; to?: Offset }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (path !== undefined) {
            // Single path read
            const stream = yield* getOrCreateStream(path);
            return stream.read({
              ...(from !== undefined && { from }),
              ...(to !== undefined && { to }),
            });
          }

          // All paths read - historical only from storage
          const afterOffset = from ?? Offset.make("-1");
          const existingPaths = yield* storageManager.listPaths();

          if (existingPaths.length === 0) {
            return Stream.empty;
          }

          return Stream.mergeAll(
            existingPaths.map((p) =>
              storageManager.read({ path: p, from: afterOffset, ...(to !== undefined && { to }) }),
            ),
            { concurrency: "unbounded" },
          );
        }).pipe(Effect.withSpan("StreamManager.read")),
      ).pipe(Stream.catchAllCause(() => Stream.empty));

    return StreamManager.of({ forPath, append, subscribe, read });
  }),
);
