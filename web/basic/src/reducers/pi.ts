/**
 * PI Reducer - Pure reducer over PI SDK AgentSessionEvent
 */
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type {
  ContentBlock,
  MessageFeedItem,
  ToolState,
  ToolFeedItem,
} from "@kiterate/server-basic/feed-types";

export type { ContentBlock, MessageFeedItem, ToolState, ToolFeedItem };

/** PI-specific FeedItem (narrower than the full backend FeedItem) */
export type FeedItem = MessageFeedItem | ToolFeedItem;

export interface PiState {
  feed: FeedItem[];
  isStreaming: boolean;
  streamingMessage?: MessageFeedItem | undefined;
  activeTools: Map<string, { feedIndex: number }>;
}

export function createInitialPiState(): PiState {
  return { feed: [], isStreaming: false, activeTools: new Map() };
}

function msg(
  role: "user" | "assistant",
  content: ContentBlock[],
  timestamp: number,
): MessageFeedItem {
  return { kind: "message", role, content, timestamp };
}

function extractText(content: unknown[] | undefined): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (c): c is { type: "text"; text: string } =>
        typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
    )
    .map((c) => ({ type: "text", text: c.text || "" }));
}

function clearStreaming(state: PiState): PiState {
  const { streamingMessage: _, ...rest } = state;
  return { ...rest, isStreaming: false };
}

export function piReducer(state: PiState, event: AgentSessionEvent): PiState {
  const now = Date.now();

  const findToolIndex = (toolCallId: string): number | undefined => {
    for (let i = state.feed.length - 1; i >= 0; i -= 1) {
      const item = state.feed[i];
      if (item.kind === "tool" && item.toolCallId === toolCallId) {
        return i;
      }
    }
    return undefined;
  };

  switch (event.type) {
    case "tool_execution_start": {
      const item: ToolFeedItem = {
        kind: "tool",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        state: "pending",
        input: event.args,
        startTimestamp: now,
      };
      const feed = [...state.feed, item];
      const activeTools = new Map(state.activeTools);
      activeTools.set(event.toolCallId, { feedIndex: feed.length - 1 });
      return { ...state, feed, activeTools };
    }

    case "tool_execution_update": {
      const active = state.activeTools.get(event.toolCallId);
      const toolIndex = active?.feedIndex ?? findToolIndex(event.toolCallId);
      if (toolIndex === undefined) return state;
      const feed = [...state.feed];
      feed[toolIndex] = {
        ...(feed[toolIndex] as ToolFeedItem),
        state: "running",
        output: event.partialResult,
      };
      const activeTools = new Map(state.activeTools);
      if (!active || active.feedIndex !== toolIndex) {
        activeTools.set(event.toolCallId, { feedIndex: toolIndex });
      }
      return { ...state, feed, activeTools };
    }

    case "tool_execution_end": {
      const active = state.activeTools.get(event.toolCallId);
      const toolIndex = active?.feedIndex ?? findToolIndex(event.toolCallId);
      if (toolIndex === undefined) return state;
      const feed = [...state.feed];
      const updated: ToolFeedItem = {
        ...(feed[toolIndex] as ToolFeedItem),
        state: event.isError ? "error" : "completed",
        output: event.result,
        endTimestamp: now,
      };
      if (event.isError) {
        updated.errorText =
          typeof event.result === "string"
            ? event.result
            : ((event.result as { message?: string })?.message ?? "Failed");
      }
      feed[toolIndex] = updated;
      const activeTools = new Map(state.activeTools);
      activeTools.delete(event.toolCallId);
      return { ...state, feed, activeTools };
    }

    case "message_start": {
      const message = event.message as { role?: string; timestamp?: number };
      if (message?.role === "assistant") {
        return {
          ...state,
          isStreaming: true,
          streamingMessage: msg("assistant", [], message.timestamp ?? now),
        };
      }
      return state;
    }

    case "message_update": {
      const partial = (
        event as {
          assistantMessageEvent?: { partial?: { content?: unknown[]; timestamp?: number } };
        }
      ).assistantMessageEvent?.partial;
      if (partial?.content) {
        return {
          ...state,
          isStreaming: true,
          streamingMessage: msg(
            "assistant",
            extractText(partial.content),
            partial.timestamp ?? now,
          ),
        };
      }
      return state;
    }

    case "message_end": {
      const message = event.message as { role?: string; content?: unknown[]; timestamp?: number };
      const content = extractText(message?.content);
      // Skip user messages - they're handled by send-user-message:called in wrapperReducer
      if (message?.role === "user") return state;
      if (content.some((c) => c.text.trim())) {
        const ts = message?.timestamp ?? now;
        if (message?.role === "assistant")
          return clearStreaming({ ...state, feed: [...state.feed, msg("assistant", content, ts)] });
      }
      return message?.role === "assistant" ? clearStreaming(state) : state;
    }

    case "agent_end":
    case "turn_end":
      return clearStreaming(state);

    default:
      return state;
  }
}

export function getMessages(state: PiState): MessageFeedItem[] {
  return state.feed.filter((item): item is MessageFeedItem => item.kind === "message");
}

export function getTools(state: PiState): ToolFeedItem[] {
  return state.feed.filter((item): item is ToolFeedItem => item.kind === "tool");
}
