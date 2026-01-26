/**
 * Prompt Injection Detector Events
 *
 * Events emitted during prompt injection detection lifecycle.
 */
import { Schema } from "effect";

import { Offset } from "../../domain.js";
import { EventSchema } from "../../events.js";

// -------------------------------------------------------------------------------------
// Detection Lifecycle Events
// -------------------------------------------------------------------------------------

/** Emitted when we start checking a request for prompt injection */
export const PromptInjectionCheckStartedEvent = EventSchema.make(
  "iterate:prompt-injection:check-started",
  {
    /** The request offset being checked */
    requestOffset: Offset,
  },
);

/** Emitted when detection completes */
export const PromptInjectionCheckCompletedEvent = EventSchema.make(
  "iterate:prompt-injection:check-completed",
  {
    /** The request offset that was checked */
    requestOffset: Offset,
    /** Detection result */
    result: Schema.Literal("safe", "injection-detected"),
    /** Confidence level (0-1) */
    confidence: Schema.Number,
    /** Explanation from the detection model */
    reason: Schema.String,
  },
);

/** Emitted when a response is blocked due to injection detection */
export const PromptInjectionBlockedEvent = EventSchema.make("iterate:prompt-injection:blocked", {
  /** The request offset that was blocked */
  requestOffset: Offset,
  /** The original event type that was blocked */
  blockedEventType: Schema.String,
  /** Reason for blocking */
  reason: Schema.String,
});

/** User-visible warning message when injection is detected */
export const PromptInjectionWarningEvent = EventSchema.make("iterate:prompt-injection:warning", {
  /** The request offset with detected injection */
  requestOffset: Offset,
  /** Human-readable warning message */
  message: Schema.String,
  /** Detection confidence (0-1) */
  confidence: Schema.Number,
  /** Detailed reason from detection model */
  detectionReason: Schema.String,
});
