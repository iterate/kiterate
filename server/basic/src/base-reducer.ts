/**
 * Base Reducer - Common event processing logic
 *
 * Handles shared patterns across all event stream reducers:
 * - User message events
 * - Generic errors
 * - Unknown events (pass-through as EventFeedItem)
 */

import type {
  BaseState,
  ContentBlock,
  MessageFeedItem,
  EventFeedItem,
  ErrorFeedItem,
  FeedItem,
} from "./feed-types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Event Types
// ─────────────────────────────────────────────────────────────────────────────

export const USER_MESSAGE_EVENT = "iterate:agent:action:send-user-message:called";
export const AGENT_ERROR_EVENT = "iterate:agent:error";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function getTimestamp(e: Record<string, unknown>): number {
  if (typeof e.createdAt === "string") {
    const parsed = Date.parse(e.createdAt);
    if (!isNaN(parsed)) return parsed;
  }
  if (typeof e.timestamp === "number") return e.timestamp;
  if (typeof e.timestamp === "string") {
    const parsed = Date.parse(e.timestamp);
    if (!isNaN(parsed)) return parsed;
  }
  return Date.now();
}

export function createMessageItem(
  role: "user" | "assistant",
  content: ContentBlock[],
  timestamp: number
): MessageFeedItem {
  return { kind: "message", role, content, timestamp };
}

export function createEventItem(
  eventType: string,
  timestamp: number,
  raw: unknown
): EventFeedItem {
  return { kind: "event", eventType, timestamp, raw };
}

export function createErrorItem(
  message: string,
  timestamp: number,
  raw: unknown,
  context?: string,
  stack?: string
): ErrorFeedItem {
  return { kind: "error", message, context, stack, timestamp, raw };
}

/**
 * Helper to update an item at a specific index in the feed array.
 */
export function updateFeedItem<T extends FeedItem>(
  feed: FeedItem[],
  index: number,
  updater: (item: T) => T
): FeedItem[] {
  const newFeed = [...feed];
  newFeed[index] = updater(newFeed[index] as T);
  return newFeed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Base Reducer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Base reducer that handles common event patterns.
 * Returns the new state if the event was handled, or null if it should be
 * delegated to a more specific reducer.
 */
export function baseReducer<S extends BaseState>(state: S, event: unknown): S | null {
  const e = event as Record<string, unknown>;
  const rawEvents = [...state.rawEvents, event];
  const timestamp = getTimestamp(e);
  const eventType = typeof e.type === "string" ? e.type : "unknown";

  // Handle generic agent error events
  if (eventType === AGENT_ERROR_EVENT) {
    const payload = e.payload as { message?: string; context?: string; stack?: string } | undefined;
    return {
      ...state,
      feed: [
        ...state.feed,
        createErrorItem(
          payload?.message ?? "Unknown error",
          timestamp,
          event,
          payload?.context,
          payload?.stack
        ),
      ],
      rawEvents,
    };
  }

  // Handle user message action events - create a user message in the feed
  if (eventType === USER_MESSAGE_EVENT) {
    const payload = e.payload as { content?: string } | undefined;
    if (payload?.content) {
      const content: ContentBlock[] = [{ type: "text", text: payload.content }];
      return {
        ...state,
        feed: [...state.feed, createMessageItem("user", content, timestamp)],
        rawEvents,
      };
    }
    // Fall through to create event item if no content
  }

  // Return null to indicate this event wasn't handled by the base reducer
  return null;
}

/**
 * Fallback handler for unhandled events - creates an EventFeedItem.
 */
export function fallbackReducer<S extends BaseState>(state: S, event: unknown): S {
  const e = event as Record<string, unknown>;
  const rawEvents = [...state.rawEvents, event];
  const timestamp = getTimestamp(e);
  const eventType = typeof e.type === "string" ? e.type : "unknown";

  return {
    ...state,
    feed: [...state.feed, createEventItem(eventType, timestamp, event)],
    rawEvents,
  };
}
