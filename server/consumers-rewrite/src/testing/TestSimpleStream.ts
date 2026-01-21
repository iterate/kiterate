/**
 * TestSimpleStream - a mock SimpleStream for testing
 *
 * Extends SimpleStream with test control methods for inspecting events,
 * waiting for subscription, and waiting for specific event types.
 */
import { DateTime, Deferred, Effect, Queue, Scope, Stream } from "effect";

import { Event, EventInput, EventType, Offset, StreamPath } from "../domain.js";
import { SimpleStream } from "../consumers/simple-consumer.js";

/** Minimal interface for EventSchema - just needs type property */
interface EventSchemaLike {
  readonly type: EventType;
}

/** Accept either an EventType or an EventSchema */
type EventTypeOrSchema = EventType | EventSchemaLike;

const getEventType = (typeOrSchema: EventTypeOrSchema): EventType =>
  typeof typeOrSchema === "string" ? typeOrSchema : typeOrSchema.type;

export interface TestSimpleStream extends SimpleStream {
  /** Append an event and return the full Event (not just offset) */
  readonly appendEvent: (event: EventInput) => Effect.Effect<Event>;
  /** Get all events that have been appended */
  readonly getEvents: () => Effect.Effect<readonly Event[]>;
  /** Wait until subscribe has been called */
  readonly waitForSubscribe: () => Effect.Effect<void>;
  /** Wait for an event of a specific type to be appended (accepts EventType or EventSchema) */
  readonly waitForEvent: (typeOrSchema: EventTypeOrSchema) => Effect.Effect<Event>;
  /** Wait for N events of a specific type to be appended */
  readonly waitForEventCount: (
    typeOrSchema: EventTypeOrSchema,
    count: number,
  ) => Effect.Effect<readonly Event[]>;
}

export const makeTestSimpleStream = (
  path: StreamPath,
): Effect.Effect<TestSimpleStream, never, Scope.Scope> =>
  Effect.gen(function* () {
    const events: Event[] = [];
    const subscribers = yield* Queue.unbounded<Event>();
    const subscribed = yield* Deferred.make<void>();
    // Waiters for single events by type
    const singleWaiters = new Map<string, Deferred.Deferred<Event>>();
    // Waiters for count-based events: Map<type, Array<{count, deferred, collected}>>
    const countWaiters = new Map<
      string,
      Array<{ count: number; deferred: Deferred.Deferred<readonly Event[]>; collected: Event[] }>
    >();
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
        const type = String(event.type);

        // Notify single-event waiters
        const singleDeferred = singleWaiters.get(type);
        if (singleDeferred) {
          yield* Deferred.succeed(singleDeferred, event);
          singleWaiters.delete(type);
        }

        // Notify count-based waiters
        const countWaiterList = countWaiters.get(type);
        if (countWaiterList) {
          for (const waiter of countWaiterList) {
            waiter.collected.push(event);
            if (waiter.collected.length >= waiter.count) {
              yield* Deferred.succeed(waiter.deferred, waiter.collected);
            }
          }
          // Remove completed waiters
          const remaining = countWaiterList.filter((w) => w.collected.length < w.count);
          if (remaining.length === 0) {
            countWaiters.delete(type);
          } else {
            countWaiters.set(type, remaining);
          }
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

      waitForEvent: (typeOrSchema) =>
        Effect.gen(function* () {
          const type = getEventType(typeOrSchema);
          const existing = events.find((e) => e.type === type);
          if (existing) return existing;
          const deferred = yield* Deferred.make<Event>();
          singleWaiters.set(String(type), deferred);
          return yield* Deferred.await(deferred);
        }),

      waitForEventCount: (typeOrSchema, count) =>
        Effect.gen(function* () {
          const type = getEventType(typeOrSchema);
          const typeStr = String(type);
          const existing = events.filter((e) => e.type === type);
          if (existing.length >= count) return existing.slice(0, count);

          const deferred = yield* Deferred.make<readonly Event[]>();
          const waiter = { count, deferred, collected: [...existing] };
          const list = countWaiters.get(typeStr) ?? [];
          list.push(waiter);
          countWaiters.set(typeStr, list);
          return yield* Deferred.await(deferred);
        }),
    };
  });
