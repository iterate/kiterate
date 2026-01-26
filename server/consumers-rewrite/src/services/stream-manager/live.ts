/**
 * Live implementation of StreamManager
 */
import { Effect, Layer, PubSub, Stream } from "effect";

import { Event, EventInput, Offset, StreamPath } from "../../domain.js";
import { InterceptorRegistry } from "../../interceptors/service.js";
import { StreamStorageManager } from "../stream-storage/service.js";
import * as EventStream from "./eventStream.js";
import { StreamManager } from "./service.js";

// -------------------------------------------------------------------------------------
// StreamManager layer
// -------------------------------------------------------------------------------------

export const liveLayer: Layer.Layer<
  StreamManager,
  never,
  StreamStorageManager | InterceptorRegistry
> = Layer.effect(
  StreamManager,
  Effect.gen(function* () {
    const storageManager = yield* StreamStorageManager;
    const interceptorRegistry = yield* InterceptorRegistry;
    const streams = new Map<StreamPath, EventStream.EventStream>();

    // Global PubSub for all events (used for "all paths" subscriptions)
    const globalPubSub = yield* PubSub.unbounded<Event>();

    const getOrCreateStream = Effect.fn("StreamManager.getOrCreateStream")(function* (
      path: StreamPath,
    ) {
      const existing = streams.get(path);
      if (existing) return existing;

      const storage = storageManager.forPath(path);
      // Pass interceptors to EventStream - they're evaluated at append time,
      // so interceptors registered after stream creation still apply
      const stream = yield* EventStream.make(storage, path, interceptorRegistry.list());
      streams.set(path, stream);
      return stream;
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

    const beSubscribedTo = ({ path, from }: { path?: StreamPath; from?: Offset }) => {
      if (path !== undefined) {
        // Single path subscription
        return Stream.unwrap(
          Effect.gen(function* () {
            const stream = yield* getOrCreateStream(path);
            return stream.subscribe({ ...(from !== undefined && { from }) });
          }).pipe(Effect.withSpan("StreamManager.subscribe")),
        ).pipe(Stream.catchAllCause(() => Stream.empty));
      }

      // All paths subscription - live events only (use read({}) for historical)
      // Use scoped: true to eagerly create the subscription when the stream is unwrapped
      return Stream.unwrapScoped(Stream.fromPubSub(globalPubSub, { scoped: true })).pipe(
        Stream.catchAllCause(() => Stream.empty),
      );
    };

    const read = ({ path, from, to }: { path: StreamPath; from?: Offset; to?: Offset }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const stream = yield* getOrCreateStream(path);
          return stream.read({
            ...(from !== undefined && { from }),
            ...(to !== undefined && { to }),
          });
        }).pipe(Effect.withSpan("StreamManager.read")),
      ).pipe(Stream.catchAllCause(() => Stream.empty));

    return StreamManager.of({ forPath, append, subscribe: beSubscribedTo, read });
  }),
);
