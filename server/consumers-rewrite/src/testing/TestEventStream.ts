/**
 * TestEventStream - a mock EventStream for testing
 *
 * Extends EventStream with test control methods for inspecting events,
 * waiting for subscription, and waiting for specific event types.
 *
 * The wait methods consume events - each call returns the *next* matching event,
 * not one that was already returned by a previous wait.
 */
import { DateTime, Deferred, Duration, Effect, Option, Queue, Scope, Stream } from "effect";

import { Event, EventInput, EventType, Offset, StreamPath } from "../domain.js";
import { EventStream } from "../services/stream-manager/index.js";
import { SpanId, TraceContext, TraceId } from "../tracing/traceContext.js";

/** Default timeout for wait operations */
const DEFAULT_TIMEOUT = Duration.millis(300);

/** EventSchema interface matching the actual EventSchema from events.ts */
interface EventSchema<Type extends string, P> {
  readonly type: EventType;
  readonly typeString: Type;
  readonly is: <E extends EventInput | Event>(event: E) => event is E & { type: Type; payload: P };
}

/** Infer the payload type from an EventSchema */
type PayloadOf<S> = S extends EventSchema<string, infer P> ? P : never;

/** Infer the type string from an EventSchema */
type TypeOf<S> = S extends EventSchema<infer T, unknown> ? T : never;

/** Typed event result - includes both the narrowed type and payload */
type TypedEvent<S> = Event & { type: TypeOf<S>; payload: PayloadOf<S> };

/** Options for wait operations */
interface WaitOptions {
  readonly timeout?: Duration.DurationInput;
}

export interface TestEventStream extends EventStream.EventStream {
  /** Get all events that have been appended */
  readonly getEvents: () => Effect.Effect<readonly Event[]>;
  /** Wait until subscribe has been called */
  readonly waitForSubscribe: (options?: WaitOptions) => Effect.Effect<void>;
  /** Wait for the next event matching the schema (consumes it from the queue) */
  readonly waitForEvent: <S extends EventSchema<string, unknown>>(
    schema: S,
    options?: WaitOptions,
  ) => Effect.Effect<TypedEvent<S>>;
  /** Wait for N events matching the schema (consumes them from the queue) */
  readonly waitForEventCount: <S extends EventSchema<string, unknown>>(
    schema: S,
    count: number,
    options?: WaitOptions,
  ) => Effect.Effect<readonly TypedEvent<S>[]>;
  /** Alias for append - convenient for tests */
  readonly appendEvent: (input: EventInput) => Effect.Effect<Event>;
}

export const makeTestEventStream = (
  path: StreamPath,
): Effect.Effect<TestEventStream, never, Scope.Scope> =>
  Effect.gen(function* () {
    const events: Event[] = [];
    const subscribers = yield* Queue.unbounded<Event>();
    const subscribed = yield* Deferred.make<void>();

    // Track consumed count per event type - waitForEvent consumes events
    const consumedCounts = new Map<string, number>();

    // Waiters for events: Map<type, Array<{needed, deferred, collected}>>
    const waiters = new Map<
      string,
      Array<{ needed: number; deferred: Deferred.Deferred<readonly Event[]>; collected: Event[] }>
    >();

    let nextOffset = 0;
    let nextSpanId = 0;

    // Generate deterministic test trace context
    const testTraceId = TraceId.make(`test-trace-${path}`);
    const makeTestTrace = (): TraceContext =>
      TraceContext.make({
        traceId: testTraceId,
        spanId: SpanId.make(`test-span-${nextSpanId++}`),
        parentSpanId: Option.none(),
      });

    const makeEvent = (input: EventInput): Event =>
      Event.make({
        ...input,
        path,
        offset: Offset.make(String(nextOffset++).padStart(16, "0")),
        createdAt: DateTime.unsafeNow(),
        trace: makeTestTrace(),
      });

    const notifyWaiters = (event: Event) =>
      Effect.gen(function* () {
        const type = String(event.type);
        const waiterList = waiters.get(type);
        if (!waiterList) return;

        for (const waiter of waiterList) {
          waiter.collected.push(event);
          if (waiter.collected.length >= waiter.needed) {
            yield* Deferred.succeed(waiter.deferred, waiter.collected);
          }
        }
        // Remove completed waiters
        const remaining = waiterList.filter((w) => w.collected.length < w.needed);
        if (remaining.length === 0) {
          waiters.delete(type);
        } else {
          waiters.set(type, remaining);
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

    const withTimeout = <A, E>(
      effect: Effect.Effect<A, E>,
      options?: WaitOptions,
    ): Effect.Effect<A, E> => {
      const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
      return effect.pipe(
        Effect.timeoutFail({
          duration: timeout,
          onTimeout: () =>
            new Error(
              `Timeout waiting for event after ${Duration.toMillis(Duration.decode(timeout))}ms`,
            ) as E,
        }),
      );
    };

    const waitForEvents = <S extends EventSchema<string, unknown>>(
      schema: S,
      count: number,
      options?: WaitOptions,
    ): Effect.Effect<readonly TypedEvent<S>[]> =>
      withTimeout(
        Effect.gen(function* () {
          const type = String(schema.type);

          // Get current consumed count for this type
          const consumed = consumedCounts.get(type) ?? 0;

          // Find unconsumed events of this type
          const allOfType = events.filter((e): e is TypedEvent<S> => schema.is(e));
          const unconsumed = allOfType.slice(consumed);

          if (unconsumed.length >= count) {
            // We have enough - consume them and return
            consumedCounts.set(type, consumed + count);
            return unconsumed.slice(0, count);
          }

          // Need to wait for more events
          const needed = count - unconsumed.length;
          const deferred = yield* Deferred.make<readonly Event[]>();
          const waiter = {
            needed: needed + unconsumed.length,
            deferred,
            collected: [...unconsumed] as Event[],
          };
          const list = waiters.get(type) ?? [];
          list.push(waiter);
          waiters.set(type, list);

          const result = yield* Deferred.await(deferred);
          // Mark all as consumed
          consumedCounts.set(type, consumed + count);
          // Filter through schema.is to ensure proper typing
          return result.slice(0, count).filter((e): e is TypedEvent<S> => schema.is(e));
        }),
        options,
      );

    return {
      // EventStream interface
      read: (options?: { from?: Offset; to?: Offset }) => {
        const snapshot = [...events];
        return Stream.fromIterable(snapshot).pipe(
          Stream.filter((e) => (options?.from ? Offset.gt(e.offset, options.from) : true)),
        );
      },

      subscribe: (options?: { from?: Offset }) =>
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

      append: appendImpl,
      appendEvent: appendImpl,

      // Test control methods
      getEvents: () => Effect.sync(() => events),

      waitForSubscribe: (options) => withTimeout(Deferred.await(subscribed), options),

      waitForEvent: (schema, options) =>
        waitForEvents(schema, 1, options).pipe(Effect.map((events) => events[0])),

      waitForEventCount: waitForEvents,
    };
  });
