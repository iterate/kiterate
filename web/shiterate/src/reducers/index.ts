/**
 * Reducers Index
 *
 * Central export point for all reducers.
 * - Identity reducer for raw event accumulation
 * - PI reducer for AI element rendering
 */

// ─────────────────────────────────────────────────────────────────────────────
// Re-export PI reducer and types
// ─────────────────────────────────────────────────────────────────────────────

export {
  // Reducer
  piReducer,
  messagesReducer, // deprecated alias
  // State creators
  createInitialPiState,
  createInitialState, // deprecated alias
  // Batch reducers
  reducePiEvents,
  reduceEvents, // deprecated alias
  // Types
  type PiState,
  type MessagesState, // deprecated alias
  type FeedItem,
  type MessageFeedItem,
  type EventFeedItem,
  type ErrorFeedItem,
  type ToolFeedItem,
  type ToolState,
  type ReasoningFeedItem,
  type CompactionFeedItem,
  type RetryFeedItem,
  type GroupedEventFeedItem,
  type ContentBlock,
  // Selectors
  getMessages,
  getTools,
  getReasoning,
  getCompactions,
  getRetries,
  getErrors,
  getEvents,
  getActiveTools,
  isReasoningActive,
  isCompactionActive,
  isRetryActive,
} from "./pi";

// ─────────────────────────────────────────────────────────────────────────────
// Stream Event Type
// ─────────────────────────────────────────────────────────────────────────────

export interface StreamEvent {
  type: string;
  offset?: string;
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection Status
// ─────────────────────────────────────────────────────────────────────────────

export type ConnectionStatus =
  | { state: "connecting" }
  | { state: "connected" }
  | { state: "error"; message: string }
  | { state: "closed" };

// ─────────────────────────────────────────────────────────────────────────────
// Identity Reducer (for raw event mode)
// ─────────────────────────────────────────────────────────────────────────────

export interface RawState {
  events: unknown[];
}

export function createInitialRawState(): RawState {
  return { events: [] };
}

/**
 * Identity reducer that simply accumulates events.
 * Used for "raw" display mode where events aren't transformed.
 */
export function rawReducer(state: RawState, event: unknown): RawState {
  return { events: [...state.events, event] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Filters
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Filter that excludes chunk/update events (transient streaming events).
 */
export function excludeChunks(event: StreamEvent): boolean {
  return event.type !== "message_updated" && event.type !== "message_chunk";
}

/**
 * Create a filter that only includes specific event types.
 */
export function onlyTypes(...types: string[]) {
  const set = new Set(types);
  return (event: StreamEvent): boolean => set.has(event.type);
}

/**
 * Create a filter that excludes specific event types.
 */
export function excludeTypes(...types: string[]) {
  const set = new Set(types);
  return (event: StreamEvent): boolean => !set.has(event.type);
}
