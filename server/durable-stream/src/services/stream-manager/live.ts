/**
 * Live implementation of StreamManager
 */
import { Effect, Layer, Stream } from "effect";

import { EventInput, Offset, StreamPath } from "../../domain.js";
import { StreamStorage } from "../stream-storage/service.js";
import * as IterateStream from "./iterateStream.js";
import { StreamManager } from "./service.js";

// -------------------------------------------------------------------------------------
// StreamManager layer
// -------------------------------------------------------------------------------------

export const liveLayer: Layer.Layer<StreamManager, never, StreamStorage> = Layer.effect(
  StreamManager,
  Effect.gen(function* () {
    const storage = yield* StreamStorage;
    const streams = new Map<StreamPath, IterateStream.IterateStream>();

    const getOrCreateStream = Effect.fn(function* (path: StreamPath) {
      const existing = streams.get(path);
      if (existing) {
        return existing;
      }
      const stream = yield* IterateStream.make({ storage, path });
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
      yield* stream.append({ event });
    });

    const subscribe = ({
      path,
      after,
      live,
    }: {
      path: StreamPath;
      after?: Offset;
      live?: boolean;
    }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const stream = yield* getOrCreateStream(path);
          return stream.subscribe({
            ...(after !== undefined && { after }),
            ...(live !== undefined && { live }),
          });
        }).pipe(Effect.withSpan("StreamManager.subscribe")),
      );

    return { append, subscribe };
  }),
);
