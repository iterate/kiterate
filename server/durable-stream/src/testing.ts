/**
 * Test utilities for durable-stream
 */
import { Chunk, Effect, Queue, Stream, Take } from "effect";

import { Event } from "./StreamManager.js";
import { StreamClient } from "./StreamClient.js";

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
    const client = yield* StreamClient;
    const stream: Stream.Stream<Event, Error> = client.subscribe(path);
    const queue: Queue.Dequeue<Take.Take<Event, Error>> = yield* Stream.toQueue(stream);
    yield* Effect.sleep("10 millis");
    return makeSubscription(queue);
  });
