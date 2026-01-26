/**
 * Interceptor Types
 *
 * Interceptors allow processors to intercept events before they're stored.
 * When an event matches an interceptor's criteria, the event type is prefixed
 * with "intercepted:" and the interceptor is recorded in the event's interceptions
 * array. The processor that registered the interceptor is then responsible for
 * watching for intercepted events and re-emitting transformed versions.
 *
 * Key properties:
 * - First-match wins: only one interceptor intercepts per event
 * - Re-emitted events carry forward the interceptions array, so the same
 *   interceptor won't re-intercept, allowing the next interceptor in line
 * - Event log preserves truth: both intercepted and re-emitted events are stored
 */

// Re-export Interception from domain to avoid circular imports
export { Interception } from "../domain.js";

// -------------------------------------------------------------------------------------
// Interceptor definition
// -------------------------------------------------------------------------------------

/**
 * An interceptor definition.
 *
 * Processors register interceptors to declare which events they want to intercept.
 * The processor is then responsible for separately watching for `intercepted:*`
 * events and re-emitting transformed versions.
 */
export interface Interceptor {
  /** Unique name (used in interception records to prevent re-interception) */
  readonly name: string;

  /**
   * JSONata expression that returns truthy to intercept.
   * The expression receives an object with { type, payload } from the event.
   *
   * Examples:
   * - `type = "user-message"` - match exact type
   * - `$contains(type, "message")` - match types containing "message"
   * - `payload.sensitive = true` - match based on payload
   */
  readonly match: string;
}

// -------------------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------------------

/** Prefix added to event types when intercepted */
export const INTERCEPTED_PREFIX = "intercepted:";

// TODO: Support explicit deletion/redaction of intercepted events for sensitive data handling
