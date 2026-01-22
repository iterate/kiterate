/**
 * In-memory implementation of StreamStorageManager
 */
import { DateTime, Effect, Layer, Stream } from "effect";

import { Event, EventInput, Offset, StreamPath } from "../../domain.js";
import { StreamStorage, StreamStorageManager, StreamStorageManagerTypeId } from "./service.js";

export const inMemoryLayer: Layer.Layer<StreamStorageManager> = Layer.sync(
  StreamStorageManager,
  () => {
    const streams = new Map<StreamPath, { events: Event[]; nextOffset: number }>();

    const getOrCreateStream = (path: StreamPath) => {
      let stream = streams.get(path);
      if (!stream) {
        stream = { events: [], nextOffset: 0 };
        streams.set(path, stream);
      }
      return stream;
    };

    const formatOffset = (n: number): Offset => Offset.make(n.toString().padStart(16, "0"));

    const append = ({ path, event: input }: { path: StreamPath; event: EventInput }) =>
      Effect.gen(function* () {
        const stream = getOrCreateStream(path);
        const offset = formatOffset(stream.nextOffset++);
        const createdAt = yield* DateTime.now;
        const event = Event.make({ ...input, path, offset, createdAt });
        stream.events.push(event);
        return event;
      });

    const read = ({ path, from, to }: { path: StreamPath; from?: Offset; to?: Offset }) =>
      Stream.suspend(() => {
        const stream = getOrCreateStream(path);
        let events = stream.events;
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
      append: (event) => append({ path, event }).pipe(Effect.orDie),
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
