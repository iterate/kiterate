/**
 * In-memory implementation of StreamStorageManager
 */
import { Effect, Layer, Stream } from "effect";

import { Event, Offset, StreamPath } from "../../domain.js";
import { StreamStorage, StreamStorageManager, StreamStorageManagerTypeId } from "./service.js";

export const inMemoryLayer: Layer.Layer<StreamStorageManager> = Layer.sync(
  StreamStorageManager,
  () => {
    const streams = new Map<StreamPath, Event[]>();

    const getOrCreateStream = (path: StreamPath) => {
      let stream = streams.get(path);
      if (!stream) {
        stream = [];
        streams.set(path, stream);
      }
      return stream;
    };

    const append = (event: Event) =>
      Effect.sync(() => {
        const stream = getOrCreateStream(event.path);
        stream.push(event);
        return event;
      });

    const read = ({ path, from, to }: { path: StreamPath; from?: Offset; to?: Offset }) =>
      Stream.suspend(() => {
        const stream = getOrCreateStream(path);
        let events = stream;
        if (from !== undefined) {
          events = events.filter((e) => e.offset > from);
        }
        if (to !== undefined) {
          events = events.filter((e) => e.offset <= to);
        }
        return Stream.fromIterable(events);
      });

    const forPath = (path: StreamPath): StreamStorage => ({
      read: (options) =>
        read({
          path,
          ...(options?.from !== undefined && { from: options.from }),
          ...(options?.to !== undefined && { to: options.to }),
        }).pipe(Stream.catchAllCause(() => Stream.empty)),
      append: (event) => append(event).pipe(Effect.orDie),
    });

    return StreamStorageManager.of({
      [StreamStorageManagerTypeId]: StreamStorageManagerTypeId,
      listPaths: () => Effect.succeed(Array.from(streams.keys())),
      forPath,
      append,
      read,
    });
  },
);
