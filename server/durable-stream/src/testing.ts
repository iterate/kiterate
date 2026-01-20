/**
 * Test utilities for durable-stream
 */
import { Chunk, Effect, Queue, Stream, Take } from "effect";

import type { Event } from "./domain.js";
import * as StreamClient from "./services/stream-client/index.js";

// -------------------------------------------------------------------------------------
// Subscription helper - wraps a queue with take/takeN methods
// -------------------------------------------------------------------------------------

export interface Subscription<A> {
  readonly take: Effect.Effect<A>;
  readonly takeN: (n: number) => Effect.Effect<readonly A[]>;
}

export const makeSubscription = <A, E>(queue: Queue.Dequeue<Take.Take<A, E>>): Subscription<A> => {
  const take = Queue.take(queue).pipe(
    Effect.flatMap(Take.done),
    Effect.map((chunk) => Chunk.unsafeHead(chunk)),
  ) as Effect.Effect<A>;

  const takeN = (n: number) =>
    Effect.all(Array.from({ length: n }, () => take)) as Effect.Effect<readonly A[]>;

  return { take, takeN };
};

// -------------------------------------------------------------------------------------
// StreamClient subscription - for client tests
// Uses Stream.toQueue which works with parsed event streams
// -------------------------------------------------------------------------------------

export const subscribeClient = (path: string) =>
  Effect.gen(function* () {
    const client = yield* StreamClient.StreamClient;
    const stream: Stream.Stream<Event, StreamClient.StreamClientError> = client.subscribe(path);
    const queue: Queue.Dequeue<Take.Take<Event, StreamClient.StreamClientError>> =
      yield* Stream.toQueue(stream);
    yield* Effect.sleep("10 millis");
    return makeSubscription(queue);
  });
