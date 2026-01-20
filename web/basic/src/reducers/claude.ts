/**
 * Claude Reducer - Pure reducer over Claude SDK V2 SDKMessage events
 */
import type {
  ContentBlock,
  MessageFeedItem,
  ToolFeedItem,
} from "@kiterate/server-basic/feed-types";

export type { ContentBlock, MessageFeedItem, ToolFeedItem };

// Claude SDK message types (simplified for frontend - no SDK import needed)
interface ClaudeSDKMessage {
  type: "assistant" | "user" | "result" | "stream_event" | "system" | string;
  session_id: string;
  message?: {
    content?: Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; id: string; name: string; input: unknown }
      | { type: "tool_result"; tool_use_id: string; content: unknown }
    >;
  };
  subtype?: "success" | string;
  result?: string;
}

/** Claude-specific FeedItem (narrower than the full backend FeedItem) */
export type FeedItem = MessageFeedItem | ToolFeedItem;

export interface ClaudeState {
  feed: FeedItem[];
  isStreaming: boolean;
  streamingMessage?: MessageFeedItem | undefined;
  activeTools: Map<string, { feedIndex: number }>;
}

export function createInitialClaudeState(): ClaudeState {
  return { feed: [], isStreaming: false, activeTools: new Map() };
}

function msg(
  role: "user" | "assistant",
  content: ContentBlock[],
  timestamp: number,
): MessageFeedItem {
  return { kind: "message", role, content, timestamp };
}

function clearStreaming(state: ClaudeState): ClaudeState {
  const { streamingMessage: _, ...rest } = state;
  return { ...rest, isStreaming: false };
}

export function claudeReducer(state: ClaudeState, event: ClaudeSDKMessage): ClaudeState {
  const now = Date.now();

  switch (event.type) {
    case "assistant": {
      // Extract text blocks from message.content
      const textBlocks =
        event.message?.content
          ?.filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => ({ type: "text", text: b.text })) ?? [];

      // Extract tool_use blocks
      const toolUseBlocks =
        event.message?.content?.filter(
          (b): b is { type: "tool_use"; id: string; name: string; input: unknown } =>
            b.type === "tool_use",
        ) ?? [];

      // Extract tool_result blocks
      const toolResultBlocks =
        event.message?.content?.filter(
          (b): b is { type: "tool_result"; tool_use_id: string; content: unknown } =>
            b.type === "tool_result",
        ) ?? [];

      let newState = state;

      // Handle tool results - update existing tool items
      for (const result of toolResultBlocks) {
        const active = newState.activeTools.get(result.tool_use_id);
        if (active) {
          const feed = [...newState.feed];
          const updated: ToolFeedItem = {
            ...(feed[active.feedIndex] as ToolFeedItem),
            state: "completed",
            output: result.content,
            endTimestamp: now,
          };
          feed[active.feedIndex] = updated;
          const activeTools = new Map(newState.activeTools);
          activeTools.delete(result.tool_use_id);
          newState = { ...newState, feed, activeTools };
        }
      }

      // Add tool items for new tool uses
      for (const tool of toolUseBlocks) {
        const item: ToolFeedItem = {
          kind: "tool",
          toolCallId: tool.id,
          toolName: tool.name,
          state: "pending",
          input: tool.input,
          startTimestamp: now,
        };
        const feed = [...newState.feed, item];
        const activeTools = new Map(newState.activeTools);
        activeTools.set(tool.id, { feedIndex: feed.length - 1 });
        newState = { ...newState, feed, activeTools };
      }

      // Add message if has text
      if (textBlocks.length > 0) {
        const msgItem = msg("assistant", textBlocks, now);
        return clearStreaming({ ...newState, feed: [...newState.feed, msgItem] });
      }

      return newState;
    }

    case "user": {
      const toolResultBlocks =
        event.message?.content?.filter(
          (b): b is { type: "tool_result"; tool_use_id: string; content: unknown } =>
            b.type === "tool_result",
        ) ?? [];

      let newState = state;

      for (const result of toolResultBlocks) {
        const active = newState.activeTools.get(result.tool_use_id);
        if (active) {
          const feed = [...newState.feed];
          const updated: ToolFeedItem = {
            ...(feed[active.feedIndex] as ToolFeedItem),
            state: "completed",
            output: result.content,
            endTimestamp: now,
          };
          feed[active.feedIndex] = updated;
          const activeTools = new Map(newState.activeTools);
          activeTools.delete(result.tool_use_id);
          newState = { ...newState, feed, activeTools };
        }
      }

      // Extract text from user message
      const textBlocks =
        event.message?.content
          ?.filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => ({ type: "text", text: b.text })) ?? [];

      if (textBlocks.length > 0) {
        const msgItem = msg("user", textBlocks, now);
        return { ...newState, feed: [...newState.feed, msgItem] };
      }
      return newState;
    }

    case "result":
      return clearStreaming(state);

    case "stream_event":
      return { ...state, isStreaming: true };

    default:
      return state;
  }
}

export function getMessages(state: ClaudeState): MessageFeedItem[] {
  return state.feed.filter((item): item is MessageFeedItem => item.kind === "message");
}

export function getTools(state: ClaudeState): ToolFeedItem[] {
  return state.feed.filter((item): item is ToolFeedItem => item.kind === "tool");
}
