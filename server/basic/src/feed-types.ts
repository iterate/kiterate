/**
 * Feed Types - Shared types for event stream UI rendering
 *
 * These types define the unified feed format that reducers produce
 * for UI consumption. They are agent-agnostic and can be used by
 * any event stream reducer.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Content Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ContentBlock {
  type: string;
  text: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Feed Item Types
// ─────────────────────────────────────────────────────────────────────────────

export interface MessageFeedItem {
  kind: "message";
  role: "user" | "assistant";
  content: ContentBlock[];
  timestamp: number;
  /** Base64 audio data for playback (PCM s16le, 48kHz for Grok, or recorded user audio) */
  audioData?: string;
}

export interface EventFeedItem {
  kind: "event";
  eventType: string;
  timestamp: number;
  raw: unknown;
}

export interface ErrorFeedItem {
  kind: "error";
  message: string;
  context?: string;
  stack?: string;
  timestamp: number;
  raw: unknown;
}

/**
 * Tool execution feed item - tracks tool lifecycle for AI Element rendering.
 */
export type ToolState =
  | "pending" // tool_execution_start received, waiting for execution
  | "running" // execution in progress (updates received)
  | "completed" // tool_execution_end received with success
  | "error"; // tool_execution_end received with isError=true

export interface ToolFeedItem {
  kind: "tool";
  toolCallId: string;
  toolName: string;
  state: ToolState;
  input: unknown;
  output?: unknown;
  errorText?: string;
  startTimestamp: number;
  endTimestamp?: number;
}

/**
 * Grouped event feed item - multiple consecutive events of the same type.
 * Used in "raw + pretty" mode to collapse repeated event types.
 */
export interface GroupedEventFeedItem {
  kind: "grouped-event";
  eventType: string;
  count: number;
  events: EventFeedItem[];
  firstTimestamp: number;
  lastTimestamp: number;
}

export type FeedItem =
  | MessageFeedItem
  | EventFeedItem
  | ErrorFeedItem
  | ToolFeedItem
  | GroupedEventFeedItem;

// ─────────────────────────────────────────────────────────────────────────────
// State Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Active tool execution being tracked (before completion).
 */
export interface ActiveToolExecution {
  toolCallId: string;
  toolName: string;
  input: unknown;
  startTimestamp: number;
  feedIndex: number;
}

/**
 * Base state shape for event stream reducers.
 */
export interface BaseState {
  feed: FeedItem[];
  isStreaming: boolean;
  streamingMessage?: MessageFeedItem | undefined;
  rawEvents: unknown[];
  activeTools: Map<string, ActiveToolExecution>;
}

/**
 * Create initial base state.
 */
export function createInitialBaseState(): BaseState {
  return {
    feed: [],
    isStreaming: false,
    rawEvents: [],
    activeTools: new Map(),
  };
}
