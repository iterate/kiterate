/**
 * Tracing helpers for event provenance.
 *
 * Provides utilities to:
 * - Read TraceContext from the current Effect span
 * - Create ExternalSpan from an Event's trace context
 * - Pipe helper to inherit trace context from an event
 */
import { Effect, Option, Tracer } from "effect";

import type { Event } from "../domain.js";
import { SpanId, TraceContext, TraceId } from "./traceContext.js";

// -------------------------------------------------------------------------------------
// Reading trace context
// -------------------------------------------------------------------------------------

/**
 * Read TraceContext from the current Effect span.
 * Returns a synthetic trace context if no span exists.
 * Used by EventStream.append to embed trace info in events.
 */
export const fromCurrentSpan: Effect.Effect<TraceContext> = Effect.currentSpan.pipe(
  Effect.map((span) =>
    TraceContext.make({
      traceId: TraceId.make(span.traceId),
      spanId: SpanId.make(span.spanId),
      parentSpanId: Option.map(span.parent, (p) => SpanId.make(p.spanId)),
    }),
  ),
  Effect.orElseSucceed(() =>
    TraceContext.make({
      traceId: TraceId.make(`untraced-${Date.now()}-${Math.random().toString(36).slice(2)}`),
      spanId: SpanId.make("untraced"),
      parentSpanId: Option.none(),
    }),
  ),
);

// -------------------------------------------------------------------------------------
// Linking to event traces
// -------------------------------------------------------------------------------------

/**
 * Create an ExternalSpan from an Event's trace context.
 * Used to link processor work to the originating event's trace.
 */
export const externalSpanFromEvent = (event: Event): Tracer.ExternalSpan =>
  Tracer.externalSpan({
    traceId: event.trace.traceId,
    spanId: event.trace.spanId,
    sampled: true,
  });

/**
 * Pipe helper: inherit trace context from an event.
 * Usage: someEffect.pipe(withTraceFromEvent(event))
 */
export const withTraceFromEvent =
  (event: Event) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.withParentSpan(self, externalSpanFromEvent(event));
