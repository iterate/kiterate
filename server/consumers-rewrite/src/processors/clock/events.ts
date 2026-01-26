/**
 * Clock Processor Events
 *
 * Events emitted by the Clock processor to provide time awareness to other processors.
 */
import { Schema } from "effect";

import { EventSchema } from "../../events.js";

// -------------------------------------------------------------------------------------
// Time Events
// -------------------------------------------------------------------------------------

/**
 * Emitted periodically to provide a heartbeat with elapsed time since stream start.
 *
 * Other processors can react to this event to perform periodic tasks (e.g., polling
 * for deferred block completion, checking timeouts, etc.).
 */
export const TimeTickEvent = EventSchema.make("iterate:time:tick", {
  /** Seconds elapsed since the stream started (first event's createdAt) */
  elapsedSeconds: Schema.Number,
});
export type TimeTickEvent = typeof TimeTickEvent.Type;
