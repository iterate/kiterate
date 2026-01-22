/**
 * Reducers Index
 *
 * Exports:
 * - PI reducer for typed AgentSessionEvent (inner events)
 * - Claude reducer for Claude SDK V2 SDKMessage events
 * - OpenCode reducer for OpenCode SDK events
 * - Wrapper reducer for envelope extraction and harness-specific events
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
import { claudeReducer as innerClaudeReducer, type FeedItem as ClaudeFeedItem } from "./claude";
import {
  openCodeReducer as innerOpenCodeReducer,
  type FeedItem as OpenCodeFeedItem,
} from "./opencode";
import { iterateReducer as innerIterateReducer, type FeedItem as IterateFeedItem } from "./iterate";
import {
  grokReducer as innerGrokReducer,
  playAudio as grokPlayAudio,
  getAudioDuration as grokGetAudioDuration,
  type FeedItem as GrokFeedItem,
  type AudioPlaybackHandle,
} from "./grok";

export { grokPlayAudio, grokGetAudioDuration, type AudioPlaybackHandle };

// ─────────────────────────────────────────────────────────────────────────────
// Re-export shared types from backend
// ─────────────────────────────────────────────────────────────────────────────

export type {
  EventFeedItem,
  ErrorFeedItem,
  GroupedEventFeedItem,
} from "@kiterate/server-basic/feed-types";

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

/** AI model type for config tracking */
export type AiModelType = "openai" | "grok";

export interface WrapperState {
  feed: FeedItem[];
  isStreaming: boolean;
  streamingMessage?: MessageFeedItem | undefined;
  activeTools: Map<string, { feedIndex: number }>;
  rawEvents: unknown[];
  openCodeMessageRoles: Map<string, "user" | "assistant">;
  openCodeMessageIndexes: Map<string, number>;
  /** Iterate agent state */
  iterateMessageIndexes: Map<string, number>;
  iterateStreamingText: string;
  iterateStreamingMessageId?: string | undefined;
  /** Grok voice state */
  grokStreamingTranscript: string;
  grokAudioChunks: string[];
  /** Pending user audio (waiting for transcript from Grok) */
  pendingUserAudio?: string | undefined;
  pendingUserAudioTimestamp?: number | undefined;
  /** Currently configured AI model (from config events) */
  configuredModel?: AiModelType | undefined;
}

export function createInitialWrapperState(): WrapperState {
  return {
    feed: [],
    isStreaming: false,
    activeTools: new Map(),
    rawEvents: [],
    openCodeMessageRoles: new Map(),
    openCodeMessageIndexes: new Map(),
    iterateMessageIndexes: new Map(),
    iterateStreamingText: "",
    grokStreamingTranscript: "",
    grokAudioChunks: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Wrapper Reducer
// ─────────────────────────────────────────────────────────────────────────────

const PI_EVENT = "iterate:agent:harness:pi:event-received";
const CLAUDE_EVENT = "iterate:agent:harness:claude:event-received";
const OPENCODE_EVENT = "iterate:agent:harness:opencode:event-received";
const OPENAI_EVENT = "iterate:llm-loop:response:sse";
const GROK_EVENT = "iterate:grok:response:sse";
const CONFIG_EVENT = "iterate:agent:config:set";
const USER_MSG = "iterate:agent:action:send-user-message:called";
const USER_AUDIO = "iterate:agent:action:send-user-audio:called";
const AGENT_ERROR = "iterate:agent:error";

function getTimestamp(e: Record<string, unknown>): number {
  if (typeof e.createdAt === "string") return Date.parse(e.createdAt) || Date.now();
  if (typeof e.timestamp === "number") return e.timestamp;
  return Date.now();
}

/**
 * Wrapper reducer that:
 * - Extracts PI events from envelope and delegates to inner reducer
 * - Creates EventFeedItem for ALL events (including PI events) for raw mode display
 * - Handles generic error events
 */
export function wrapperReducer(state: WrapperState, event: unknown): WrapperState {
  const e = event as Record<string, unknown>;
  const rawEvents = [...state.rawEvents, event];
  const t = getTimestamp(e);
  const type = (e.type as string) || "unknown";

  // Always create an EventFeedItem for raw event display
  const evtItem: EventFeedItem = { kind: "event", eventType: type, timestamp: t, raw: event };

  function insertEventItem(
    innerState: Omit<
      WrapperState,
      | "rawEvents"
      | "feed"
      | "openCodeMessageRoles"
      | "openCodeMessageIndexes"
      | "iterateMessageIndexes"
      | "iterateStreamingText"
      | "iterateStreamingMessageId"
      | "grokStreamingTranscript"
      | "grokAudioChunks"
    > & {
      feed: InnerFeedItem[];
      openCodeMessageRoles?: Map<string, "user" | "assistant">;
      openCodeMessageIndexes?: Map<string, number>;
      iterateMessageIndexes?: Map<string, number>;
      iterateStreamingText?: string;
      iterateStreamingMessageId?: string | undefined;
      grokStreamingTranscript?: string;
      grokAudioChunks?: string[];
    },
  ): WrapperState {
    const insertAt = state.feed.length;
    const feed = [...(innerState.feed as FeedItem[])];
    feed.splice(insertAt, 0, evtItem);
    const activeTools = new Map(innerState.activeTools);
    for (const [toolCallId, info] of activeTools) {
      if (info.feedIndex >= insertAt) {
        activeTools.set(toolCallId, { feedIndex: info.feedIndex + 1 });
      }
    }
    const openCodeMessageIndexes = new Map(
      innerState.openCodeMessageIndexes ?? state.openCodeMessageIndexes,
    );
    for (const [messageId, index] of openCodeMessageIndexes) {
      if (index >= insertAt) {
        openCodeMessageIndexes.set(messageId, index + 1);
      }
    }
    const iterateMessageIndexes = new Map(
      innerState.iterateMessageIndexes ?? state.iterateMessageIndexes,
    );
    for (const [messageId, index] of iterateMessageIndexes) {
      if (index >= insertAt) {
        iterateMessageIndexes.set(messageId, index + 1);
      }
    }

    return {
      ...innerState,
      feed,
      activeTools,
      rawEvents,
      openCodeMessageRoles: innerState.openCodeMessageRoles ?? state.openCodeMessageRoles,
      openCodeMessageIndexes,
      iterateMessageIndexes,
      iterateStreamingText: innerState.iterateStreamingText ?? state.iterateStreamingText,
      iterateStreamingMessageId:
        innerState.iterateStreamingMessageId ?? state.iterateStreamingMessageId,
      grokStreamingTranscript: innerState.grokStreamingTranscript ?? state.grokStreamingTranscript,
      grokAudioChunks: innerState.grokAudioChunks ?? state.grokAudioChunks,
      configuredModel: state.configuredModel,
    };
  }

  // Extract and delegate PI events to inner reducer
  if (type === PI_EVENT) {
    const piEvent = (e.payload as { piEvent?: AgentSessionEvent })?.piEvent;
    if (piEvent) {
      const innerState = innerPiReducer(
        {
          feed: state.feed as InnerFeedItem[],
          isStreaming: state.isStreaming,
          streamingMessage: state.streamingMessage,
          activeTools: state.activeTools,
        },
        piEvent,
      );
      // Insert EventFeedItem for raw display while keeping inner updates intact
      return insertEventItem(innerState);
    }
  }

  // Extract and delegate Claude events to inner reducer
  if (type === CLAUDE_EVENT) {
    const claudeEvent = (e.payload as { claudeEvent?: unknown })?.claudeEvent;
    if (claudeEvent) {
      const innerState = innerClaudeReducer(
        {
          feed: state.feed as ClaudeFeedItem[],
          isStreaming: state.isStreaming,
          streamingMessage: state.streamingMessage,
          activeTools: state.activeTools,
        },
        claudeEvent as Parameters<typeof innerClaudeReducer>[1],
      );
      return insertEventItem(innerState as typeof innerState & { feed: InnerFeedItem[] });
    }
  }

  // Extract and delegate OpenCode events to inner reducer
  if (type === OPENCODE_EVENT) {
    const openCodeEvent = (e.payload as { openCodeEvent?: unknown })?.openCodeEvent;
    if (openCodeEvent) {
      const innerState = innerOpenCodeReducer(
        {
          feed: state.feed as OpenCodeFeedItem[],
          isStreaming: state.isStreaming,
          streamingMessage: state.streamingMessage,
          activeTools: state.activeTools,
          messageRoles: state.openCodeMessageRoles,
          messageIndexes: state.openCodeMessageIndexes,
        },
        openCodeEvent as Parameters<typeof innerOpenCodeReducer>[1],
      );
      return insertEventItem({
        ...(innerState as typeof innerState & { feed: InnerFeedItem[] }),
        openCodeMessageRoles: innerState.messageRoles ?? state.openCodeMessageRoles,
        openCodeMessageIndexes: innerState.messageIndexes ?? state.openCodeMessageIndexes,
      });
    }
  }

  // Handle iterate LLM response events directly (payload is the SSE event itself)
  if (type === OPENAI_EVENT) {
    const innerState = innerIterateReducer(
      {
        feed: state.feed as IterateFeedItem[],
        isStreaming: state.isStreaming,
        streamingMessage: state.streamingMessage,
        activeTools: state.activeTools,
        messageIndexes: state.iterateMessageIndexes,
        streamingText: state.iterateStreamingText,
        streamingMessageId: state.iterateStreamingMessageId,
      },
      event as Parameters<typeof innerIterateReducer>[1],
    );
    return insertEventItem({
      ...(innerState as typeof innerState & { feed: InnerFeedItem[] }),
      iterateMessageIndexes: innerState.messageIndexes ?? state.iterateMessageIndexes,
      iterateStreamingText: innerState.streamingText ?? state.iterateStreamingText,
      iterateStreamingMessageId: innerState.streamingMessageId,
    });
  }

  // Handle Grok voice events
  if (type === GROK_EVENT) {
    const payload = e.payload as { type?: string; transcript?: string } | undefined;

    // Handle user audio transcription - merge with pending audio
    if (payload?.type === "conversation.item.input_audio_transcription.completed") {
      const transcript = payload.transcript;
      if (typeof transcript === "string" && transcript.trim()) {
        const msgItem: MessageFeedItem = {
          kind: "message",
          role: "user",
          content: [{ type: "text", text: transcript.trim() }],
          timestamp: state.pendingUserAudioTimestamp ?? t,
          ...(state.pendingUserAudio ? { audioData: state.pendingUserAudio } : {}),
        };
        return {
          ...state,
          feed: [...state.feed, evtItem, msgItem],
          rawEvents,
          pendingUserAudio: undefined,
          pendingUserAudioTimestamp: undefined,
        };
      }
      return { ...state, feed: [...state.feed, evtItem], rawEvents };
    }

    const innerState = innerGrokReducer(
      {
        feed: state.feed as GrokFeedItem[],
        isStreaming: state.isStreaming,
        streamingMessage: state.streamingMessage,
        activeTools: state.activeTools,
        streamingTranscript: state.grokStreamingTranscript,
        audioChunks: state.grokAudioChunks,
      },
      event as Parameters<typeof innerGrokReducer>[1],
    );
    return insertEventItem({
      ...(innerState as typeof innerState & { feed: InnerFeedItem[] }),
      grokStreamingTranscript: innerState.streamingTranscript,
      grokAudioChunks: innerState.audioChunks,
    });
  }

  // Config event - track the configured AI model
  if (type === CONFIG_EVENT) {
    const model = (e.payload as { model?: string })?.model;
    if (model === "openai" || model === "grok") {
      return { ...state, feed: [...state.feed, evtItem], rawEvents, configuredModel: model };
    }
    return { ...state, feed: [...state.feed, evtItem], rawEvents };
  }

  // User message action → create both EventFeedItem (for raw display) and MessageFeedItem
  // The PI SDK's message_end for user is filtered out in pi.ts to avoid duplicates
  if (type === USER_MSG) {
    const content = (e.payload as { content?: string })?.content;
    if (content) {
      const msgItem: MessageFeedItem = {
        kind: "message",
        role: "user",
        content: [{ type: "text", text: content }],
        timestamp: t,
      };
      return { ...state, feed: [...state.feed, evtItem, msgItem], rawEvents };
    }
    return { ...state, feed: [...state.feed, evtItem], rawEvents };
  }

  // User audio action → store pending audio (message created when transcript arrives)
  if (type === USER_AUDIO) {
    const audio = (e.payload as { audio?: string })?.audio;
    if (audio) {
      return {
        ...state,
        feed: [...state.feed, evtItem],
        rawEvents,
        pendingUserAudio: audio,
        pendingUserAudioTimestamp: t,
      };
    }
    return { ...state, feed: [...state.feed, evtItem], rawEvents };
  }

  // Generic agent error
  if (type === AGENT_ERROR) {
    const p = e.payload as { message?: string; context?: string; stack?: string } | undefined;
    const errItem: ErrorFeedItem = {
      kind: "error",
      message: p?.message ?? "Error",
      timestamp: t,
      raw: event,
    };
    if (p?.context) errItem.context = p.context;
    if (p?.stack) errItem.stack = p.stack;
    return { ...state, feed: [...state.feed, evtItem, errItem], rawEvents };
  }

  // Fallback: just the event item
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
