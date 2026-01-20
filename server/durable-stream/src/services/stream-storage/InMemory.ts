/**
 * In-memory implementation of StreamStorage
 */
import { DateTime, Effect, Layer, Stream } from "effect";

import { Event, Offset, StreamPath } from "../../domain.js";
import { StreamStorage, StreamStorageTypeId } from "./service.js";

export const inMemoryLayer: Layer.Layer<StreamStorage> = Layer.sync(StreamStorage, () => {
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

  return StreamStorage.of({
    [StreamStorageTypeId]: StreamStorageTypeId,
    append: ({ path, event: input }) =>
      Effect.gen(function* () {
        const stream = getOrCreateStream(path);
        const offset = formatOffset(stream.nextOffset++);
        const createdAt = yield* DateTime.now;
        const event = Event.make({ ...input, offset, createdAt });
        stream.events.push(event);
        return event;
      }),
    read: ({ path, after }) =>
      Stream.suspend(() => {
        const stream = getOrCreateStream(path);
        // after = last seen offset, so return events AFTER it (exclusive)
        const events =
          after !== undefined ? stream.events.filter((e) => e.offset > after) : stream.events;
        return Stream.fromIterable(events);
      }),
  });
});
