/**
 * TestSimpleStream - a mock SimpleStream for testing
 *
 * Extends SimpleStream with test control methods for inspecting events,
 * waiting for subscription, and waiting for specific event types.
 */
import { DateTime, Deferred, Effect, Queue, Scope, Stream } from "effect";

import { Event, EventInput, EventType, Offset, StreamPath } from "../domain.js";
import { SimpleStream } from "../consumers/simple-consumer.js";

export interface TestSimpleStream extends SimpleStream {
  /** Append an event and return the full Event (not just offset) */
  readonly appendEvent: (event: EventInput) => Effect.Effect<Event>;
  /** Get all events that have been appended */
  readonly getEvents: () => Effect.Effect<readonly Event[]>;
  /** Wait until subscribe has been called */
  readonly waitForSubscribe: () => Effect.Effect<void>;
  /** Wait for an event of a specific type to be appended */
  readonly waitForEventType: (type: EventType) => Effect.Effect<Event>;
}

export const makeTestSimpleStream = (
  path: StreamPath,
): Effect.Effect<TestSimpleStream, never, Scope.Scope> =>
  Effect.gen(function* () {
    const events: Event[] = [];
    const subscribers = yield* Queue.unbounded<Event>();
    const subscribed = yield* Deferred.make<void>();
    const waiters = new Map<string, Deferred.Deferred<Event>>();
    let nextOffset = 0;

    const makeEvent = (input: EventInput): Event =>
      Event.make({
        ...input,
        path,
        offset: Offset.make(String(nextOffset++).padStart(16, "0")),
        createdAt: DateTime.unsafeNow(),
      });

    const notifyWaiters = (event: Event) =>
      Effect.gen(function* () {
        const deferred = waiters.get(event.type);
        if (deferred) {
          yield* Deferred.succeed(deferred, event);
          waiters.delete(event.type);
        }
      });

    const appendImpl = (input: EventInput) =>
      Effect.gen(function* () {
        const event = makeEvent(input);
        events.push(event);
        yield* Queue.offer(subscribers, event);
        yield* notifyWaiters(event);
        return event;
      });

    return {
      path,

      // SimpleStream interface
      read: (options) => {
        const snapshot = [...events];
        return Stream.fromIterable(snapshot).pipe(
          Stream.filter((e) => (options?.from ? Offset.gt(e.offset, options.from) : true)),
        );
      },

      subscribe: (options) =>
        Effect.gen(function* () {
          const snapshot = [...events];
          yield* Deferred.succeed(subscribed, void 0);
          return Stream.fromIterable(snapshot).pipe(
            Stream.filter((e) => (options?.from ? Offset.gt(e.offset, options.from) : true)),
            Stream.concat(
              Stream.fromQueue(subscribers).pipe(
                Stream.filter((e) => (options?.from ? Offset.gt(e.offset, options.from) : true)),
              ),
            ),
          );
        }).pipe(Stream.unwrap),

      append: (input) => appendImpl(input).pipe(Effect.map((e) => e.offset)),

      // Test control methods
      appendEvent: appendImpl,
      getEvents: () => Effect.sync(() => events),
      waitForSubscribe: () => Deferred.await(subscribed),
      waitForEventType: (type) =>
        Effect.gen(function* () {
          const existing = events.find((e) => e.type === type);
          if (existing) return existing;
          const deferred = yield* Deferred.make<Event>();
          waiters.set(type, deferred);
          return yield* Deferred.await(deferred);
        }),
    };
  });
