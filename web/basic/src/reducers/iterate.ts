/**
 * Iterate Reducer - Pure reducer over Iterate agent SSE events
 *
 * Handles events from the iterate agent manager system, projecting
 * LLM response streams into feed items for UI rendering.
 */
import type {
  ContentBlock,
  MessageFeedItem,
  ToolFeedItem,
} from "@kiterate/server-basic/feed-types";

export type { ContentBlock, MessageFeedItem, ToolFeedItem };

// ─────────────────────────────────────────────────────────────────────────────
// Event Types
// ─────────────────────────────────────────────────────────────────────────────

interface IterateSSEPart {
  type: "response-metadata" | "text-start" | "text-delta" | "text-end" | "finish" | string;
  id?: string;
  delta?: string;
  modelId?: { _tag: string; value?: string };
  timestamp?: { _tag: string; value?: string };
  reason?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  metadata?: Record<string, unknown>;
}

interface IterateEvent {
  type: string;
  payload: { part: IterateSSEPart };
  createdAt?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

/** Iterate-specific FeedItem (narrower than the full backend FeedItem) */
export type FeedItem = MessageFeedItem | ToolFeedItem;

export interface IterateState {
  feed: FeedItem[];
  isStreaming: boolean;
  streamingMessage?: MessageFeedItem | undefined;
  activeTools: Map<string, { feedIndex: number }>;
  /** Track message IDs to their feed index for in-place updates */
  messageIndexes: Map<string, number>;
  /** Accumulated text for the current streaming message */
  streamingText: string;
  /** ID of the current streaming message */
  streamingMessageId?: string | undefined;
}

export function createInitialIterateState(): IterateState {
  return {
    feed: [],
    isStreaming: false,
    activeTools: new Map(),
    messageIndexes: new Map(),
    streamingText: "",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function msg(
  role: "user" | "assistant",
  content: ContentBlock[],
  timestamp: number,
): MessageFeedItem {
  return { kind: "message", role, content, timestamp };
}

function clearStreaming(state: IterateState): IterateState {
  const { streamingMessage: _, streamingMessageId: __, streamingText: ___, ...rest } = state;
  return { ...rest, isStreaming: false, streamingText: "" };
}

function getTimestamp(event: IterateEvent): number {
  if (event.createdAt) return Date.parse(event.createdAt) || Date.now();
  return Date.now();
}

// ─────────────────────────────────────────────────────────────────────────────
// Reducer
// ─────────────────────────────────────────────────────────────────────────────

export function iterateReducer(state: IterateState, event: IterateEvent): IterateState {
  const part = event.payload?.part;
  if (!part || typeof part.type !== "string") return state;

  const now = getTimestamp(event);
  const messageIndexes = new Map(state.messageIndexes);

  switch (part.type) {
    case "response-metadata": {
      // Response metadata arrives first, indicates a new response is starting
      return { ...state, isStreaming: true, messageIndexes };
    }

    case "text-start": {
      // A new text message is starting
      const messageId = part.id;
      return {
        ...state,
        isStreaming: true,
        streamingText: "",
        streamingMessageId: messageId,
        ...(messageId ? {} : { streamingMessage: msg("assistant", [], now) }),
        messageIndexes,
      };
    }

    case "text-delta": {
      // Accumulate text chunks
      const delta = part.delta ?? "";
      const newText = state.streamingText + delta;
      const msgItem = msg("assistant", [{ type: "text", text: newText }], now);

      // Update or create streaming message in feed
      const messageId = part.id ?? state.streamingMessageId;
      if (messageId) {
        const existingIndex = messageIndexes.get(messageId);
        if (existingIndex !== undefined && state.feed[existingIndex]?.kind === "message") {
          const existingTimestamp = (state.feed[existingIndex] as MessageFeedItem).timestamp;
          const stableItem = msg("assistant", [{ type: "text", text: newText }], existingTimestamp);
          // Update existing message in place
          const feed = [...state.feed];
          feed[existingIndex] = stableItem;
          return {
            ...state,
            feed,
            isStreaming: true,
            streamingText: newText,
            streamingMessage: undefined,
            streamingMessageId: messageId,
            messageIndexes,
          };
        }
        // Add new message to feed and track its index
        const feed = [...state.feed, msgItem];
        messageIndexes.set(messageId, feed.length - 1);
        return {
          ...state,
          feed,
          isStreaming: true,
          streamingText: newText,
          streamingMessage: undefined,
          streamingMessageId: messageId,
          messageIndexes,
        };
      }

      // No message ID - just update streaming state
      return {
        ...state,
        isStreaming: true,
        streamingText: newText,
        streamingMessage: msgItem,
        messageIndexes,
      };
    }

    case "text-end": {
      // Text message is complete
      const messageId = part.id ?? state.streamingMessageId;
      if (state.streamingText.trim()) {
        const msgItem = msg("assistant", [{ type: "text", text: state.streamingText }], now);
        if (messageId) {
          const existingIndex = messageIndexes.get(messageId);
          if (existingIndex !== undefined) {
            // Final update to existing message
            const feed = [...state.feed];
            const existingTimestamp = (state.feed[existingIndex] as MessageFeedItem).timestamp;
            feed[existingIndex] = msg(
              "assistant",
              [{ type: "text", text: state.streamingText }],
              existingTimestamp,
            );
            return clearStreaming({ ...state, feed, messageIndexes });
          }
        }
        // Message wasn't in feed yet - add it
        return clearStreaming({ ...state, feed: [...state.feed, msgItem], messageIndexes });
      }
      return clearStreaming({ ...state, messageIndexes });
    }

    case "finish": {
      // Response is fully complete
      // If there's still streaming text that wasn't finalized, add it
      if (state.streamingText.trim() && state.isStreaming) {
        const messageId = state.streamingMessageId;
        const msgItem = msg("assistant", [{ type: "text", text: state.streamingText }], now);
        if (messageId) {
          const existingIndex = messageIndexes.get(messageId);
          if (existingIndex !== undefined) {
            const feed = [...state.feed];
            const existingTimestamp = (state.feed[existingIndex] as MessageFeedItem).timestamp;
            feed[existingIndex] = msg(
              "assistant",
              [{ type: "text", text: state.streamingText }],
              existingTimestamp,
            );
            return clearStreaming({ ...state, feed, messageIndexes });
          }
        }
        return clearStreaming({ ...state, feed: [...state.feed, msgItem], messageIndexes });
      }
      return clearStreaming({ ...state, messageIndexes });
    }

    default:
      return { ...state, messageIndexes };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Selectors
// ─────────────────────────────────────────────────────────────────────────────

export function getMessages(state: IterateState): MessageFeedItem[] {
  return state.feed.filter((item): item is MessageFeedItem => item.kind === "message");
}

export function getTools(state: IterateState): ToolFeedItem[] {
  return state.feed.filter((item): item is ToolFeedItem => item.kind === "tool");
}
