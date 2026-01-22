/**
 * Live implementation of StreamManager
 */
import { Effect, Layer, PubSub, Stream, SynchronizedRef } from "effect";

import { Event, EventInput, Offset, StreamPath } from "../../domain.js";
import { StreamStorage } from "../stream-storage/service.js";
import * as EventStream from "./eventStream.js";
import { StreamManager } from "./service.js";

// -------------------------------------------------------------------------------------
// StreamManager layer
// -------------------------------------------------------------------------------------

export const liveLayer: Layer.Layer<StreamManager, never, StreamStorage> = Layer.effect(
  StreamManager,
  Effect.gen(function* () {
    const storage = yield* StreamStorage;
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

        return EventStream.make({ storage, path }).pipe(
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

    const append = Effect.fn("StreamManager.append")(function* ({
      path,
      event,
    }: {
      path: StreamPath;
      event: EventInput;
    }) {
      const stream = yield* getOrCreateStream(path);
      const storedEvent = yield* stream.append({ event });

      // Also publish to global PubSub for "all paths" subscribers
      yield* PubSub.publish(globalPubSub, storedEvent);

      return storedEvent;
    });

    const subscribe = ({
      path,
      after,
      live,
    }: {
      path?: StreamPath;
      after?: Offset;
      live?: boolean;
    }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (path !== undefined) {
            // Single path subscription
            const stream = yield* getOrCreateStream(path);
            return stream.subscribe({
              ...(after !== undefined && { after }),
              ...(live !== undefined && { live }),
            });
          }

          // All paths subscription - read directly from storage
          const afterOffset = after ?? Offset.make("-1");

          // Get all existing paths from storage
          const existingPaths = yield* storage.listPaths();

          if (!live) {
            // Historical only - read from storage for each path
            if (existingPaths.length === 0) {
              return Stream.empty;
            }
            const allStreams = existingPaths.map((p) =>
              storage.read({ path: p, after: afterOffset }),
            );
            return Stream.mergeAll(allStreams, { concurrency: "unbounded" });
          }

          // Live mode: history from storage + global PubSub for new events
          return Stream.unwrapScoped(
            Effect.gen(function* () {
              // Subscribe to global PubSub first (don't miss events during history replay)
              const queue = yield* PubSub.subscribe(globalPubSub);
              const liveStream = Stream.fromQueue(queue);

              // Read historical from storage for each path
              const historicalStream =
                existingPaths.length > 0
                  ? Stream.mergeAll(
                      existingPaths.map((p) => storage.read({ path: p, after: afterOffset })),
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
      );

    return StreamManager.of({ append, subscribe });
  }),
);
