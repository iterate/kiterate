/**
 * Live implementation of StreamManager
 */
import { Effect, Layer, PubSub, Ref, Stream } from "effect";

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
    const streams = new Map<StreamPath, EventStream.EventStream>();

    // Global PubSub for all events (used for "all paths" subscriptions)
    const globalPubSub = yield* PubSub.unbounded<Event>();

    const getOrCreateStream = Effect.fn(function* (path: StreamPath) {
      const existing = streams.get(path);
      if (existing) {
        return existing;
      }
      const stream = yield* EventStream.make({ storage, path });
      streams.set(path, stream);
      return stream;
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

              // Track last seen offset for deduplication
              const lastOffsetRef = yield* Ref.make<Offset>(afterOffset);

              const trackedHistorical = historicalStream.pipe(
                Stream.tap((event) => Ref.set(lastOffsetRef, event.offset)),
              );

              const dedupedLive = liveStream.pipe(
                Stream.filterEffect((event) =>
                  Ref.get(lastOffsetRef).pipe(
                    Effect.map((lastOffset) => event.offset > lastOffset),
                  ),
                ),
              );

              return Stream.concat(trackedHistorical, dedupedLive);
            }),
          );
        }).pipe(Effect.withSpan("StreamManager.subscribe")),
      );

    return { append, subscribe };
  }),
);
