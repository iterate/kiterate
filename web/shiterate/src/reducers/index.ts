/**
 * Reducers Index
 *
 * Exports:
 * - PI reducer for typed AgentSessionEvent (inner events)
 * - Wrapper reducer for envelope extraction and non-PI events
 * - Identity reducer for raw event accumulation
 */

import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type {
  EventFeedItem,
  ErrorFeedItem,
  GroupedEventFeedItem,
} from "@kiterate/server-basic/feed-types";
import {
  piReducer as innerPiReducer,
  createInitialPiState as createInnerPiState,
  type PiState as InnerPiState,
  type FeedItem as InnerFeedItem,
  type MessageFeedItem,
  type ToolFeedItem,
  type ToolState,
  type ContentBlock,
  getMessages,
  getTools,
} from "./pi";

// ─────────────────────────────────────────────────────────────────────────────
// Re-export shared types from backend
// ─────────────────────────────────────────────────────────────────────────────

export type { EventFeedItem, ErrorFeedItem, GroupedEventFeedItem } from "@kiterate/server-basic/feed-types";

// ─────────────────────────────────────────────────────────────────────────────
// Re-export PI types
// ─────────────────────────────────────────────────────────────────────────────

export {
  innerPiReducer as piReducer,
  createInnerPiState as createInitialPiState,
  type InnerPiState as PiState,
  type MessageFeedItem,
  type ToolFeedItem,
  type ToolState,
  type ContentBlock,
  getMessages,
  getTools,
};

// ─────────────────────────────────────────────────────────────────────────────
// Combined FeedItem type
// ─────────────────────────────────────────────────────────────────────────────

export type FeedItem = InnerFeedItem | EventFeedItem | ErrorFeedItem | GroupedEventFeedItem;

// ─────────────────────────────────────────────────────────────────────────────
// Wrapper State (includes rawEvents and handles envelope)
// ─────────────────────────────────────────────────────────────────────────────

export interface WrapperState {
  feed: FeedItem[];
  isStreaming: boolean;
  streamingMessage?: MessageFeedItem | undefined;
  activeTools: Map<string, { feedIndex: number }>;
  rawEvents: unknown[];
}

export function createInitialWrapperState(): WrapperState {
  return { feed: [], isStreaming: false, activeTools: new Map(), rawEvents: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Wrapper Reducer
// ─────────────────────────────────────────────────────────────────────────────

const PI_EVENT = "iterate:agent:harness:pi:event-received";
const USER_MSG = "iterate:agent:action:send-user-message:called";
const AGENT_ERROR = "iterate:agent:error";

function getTimestamp(e: Record<string, unknown>): number {
  if (typeof e.createdAt === "string") return Date.parse(e.createdAt) || Date.now();
  if (typeof e.timestamp === "number") return e.timestamp;
  return Date.now();
}

/**
 * Wrapper reducer that:
 * - Extracts PI events from envelope and delegates to inner reducer
 * - Handles user message action events
 * - Handles generic error events
 * - Creates EventFeedItem for other events
 */
export function wrapperReducer(state: WrapperState, event: unknown): WrapperState {
  const e = event as Record<string, unknown>;
  const rawEvents = [...state.rawEvents, event];
  const t = getTimestamp(e);
  const type = (e.type as string) || "unknown";

  // Extract and delegate PI events to inner reducer
  if (type === PI_EVENT) {
    const piEvent = (e.payload as { piEvent?: AgentSessionEvent })?.piEvent;
    if (piEvent) {
      const innerState = innerPiReducer(
        { feed: state.feed as InnerFeedItem[], isStreaming: state.isStreaming, streamingMessage: state.streamingMessage, activeTools: state.activeTools },
        piEvent
      );
      return { ...innerState, feed: innerState.feed as FeedItem[], rawEvents };
    }
  }

  // User message action → create user message
  if (type === USER_MSG) {
    const content = (e.payload as { content?: string })?.content;
    if (content) {
      const msgItem: MessageFeedItem = {
        kind: "message",
        role: "user",
        content: [{ type: "text", text: content }],
        timestamp: t,
      };
      return { ...state, feed: [...state.feed, msgItem], rawEvents };
    }
  }

  // Generic agent error
  if (type === AGENT_ERROR) {
    const p = e.payload as { message?: string; context?: string; stack?: string } | undefined;
    const errItem: ErrorFeedItem = { kind: "error", message: p?.message ?? "Error", timestamp: t, raw: event };
    if (p?.context) errItem.context = p.context;
    if (p?.stack) errItem.stack = p.stack;
    return { ...state, feed: [...state.feed, errItem], rawEvents };
  }

  // Fallback: create event item
  const evtItem: EventFeedItem = { kind: "event", eventType: type, timestamp: t, raw: event };
  return { ...state, feed: [...state.feed, evtItem], rawEvents };
}

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

export function rawReducer(state: RawState, event: unknown): RawState {
  return { events: [...state.events, event] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Filters
// ─────────────────────────────────────────────────────────────────────────────

export function excludeChunks(event: StreamEvent): boolean {
  return event.type !== "message_updated" && event.type !== "message_chunk";
}

export function onlyTypes(...types: string[]) {
  const set = new Set(types);
  return (event: StreamEvent): boolean => set.has(event.type);
}

export function excludeTypes(...types: string[]) {
  const set = new Set(types);
  return (event: StreamEvent): boolean => !set.has(event.type);
}

// ─────────────────────────────────────────────────────────────────────────────
// Wrapper State Selectors (work with full FeedItem type)
// ─────────────────────────────────────────────────────────────────────────────

/** Get all message feed items from wrapper state */
export function getWrapperMessages(state: WrapperState): MessageFeedItem[] {
  return state.feed.filter((item): item is MessageFeedItem => item.kind === "message");
}

/** Get all tool execution feed items from wrapper state */
export function getWrapperTools(state: WrapperState): ToolFeedItem[] {
  return state.feed.filter((item): item is ToolFeedItem => item.kind === "tool");
}

/** Get all error feed items from wrapper state */
export function getWrapperErrors(state: WrapperState): ErrorFeedItem[] {
  return state.feed.filter((item): item is ErrorFeedItem => item.kind === "error");
}

/** Get all event feed items from wrapper state */
export function getWrapperEvents(state: WrapperState): EventFeedItem[] {
  return state.feed.filter((item): item is EventFeedItem => item.kind === "event");
}
