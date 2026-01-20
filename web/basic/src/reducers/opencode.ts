/**
 * OpenCode Reducer - Pure reducer over OpenCode SDK event stream events
 */
import type {
  ContentBlock,
  ErrorFeedItem,
  MessageFeedItem,
  ToolFeedItem,
} from "@kiterate/server-basic/feed-types";

export type { ContentBlock, ErrorFeedItem, MessageFeedItem, ToolFeedItem };

// OpenCode event types (from SDK event stream)
interface OpenCodeEvent {
  type:
    | "message.updated"
    | "message.part.updated"
    | "session.updated"
    | "session.error"
    | "session.diff"
    | "file.edited"
    | "file.watcher.updated"
    | "session.status"
    | "session.idle"
    | string;
  properties: {
    info?: {
      id?: string;
      role?: string;
      content?: string;
      parts?: Array<{ type: string; text?: string }>;
      time?: {
        created?: number;
        updated?: number;
      };
      error?: {
        name?: string;
        data?: {
          message?: string;
        };
      };
    };
    part?: {
      id?: string;
      messageID?: string;
      type?: string;
      text?: string;
      time?: { start?: number; end?: number };
      callID?: string;
      tool?: string;
      state?: {
        status?: string;
        input?: unknown;
        output?: unknown;
        metadata?: { output?: unknown };
        time?: { start?: number; end?: number };
      };
      toolCallId?: string;
      toolName?: string;
      input?: unknown;
      args?: unknown;
      output?: unknown;
      result?: unknown;
      isError?: boolean;
      error?: { message?: string } | string;
    };
    file?: string;
    error?: string;
    event?: string;
  };
}

/** OpenCode-specific FeedItem (narrower than the full backend FeedItem) */
export type FeedItem = MessageFeedItem | ToolFeedItem | ErrorFeedItem;

export interface OpenCodeState {
  feed: FeedItem[];
  isStreaming: boolean;
  streamingMessage?: MessageFeedItem | undefined;
  activeTools: Map<string, { feedIndex: number }>;
  messageRoles: Map<string, "user" | "assistant">;
  messageIndexes: Map<string, number>;
}

export function createInitialOpenCodeState(): OpenCodeState {
  return {
    feed: [],
    isStreaming: false,
    activeTools: new Map(),
    messageRoles: new Map(),
    messageIndexes: new Map(),
  };
}

function msg(
  role: "user" | "assistant",
  content: ContentBlock[],
  timestamp: number,
): MessageFeedItem {
  return { kind: "message", role, content, timestamp };
}

function err(message: string, timestamp: number, raw?: unknown): ErrorFeedItem {
  return { kind: "error", message, timestamp, raw };
}

function clearStreaming(state: OpenCodeState): OpenCodeState {
  const { streamingMessage: _, ...rest } = state;
  return { ...rest, isStreaming: false };
}

function asTextContent(text: string): ContentBlock[] {
  return [{ type: "text", text }];
}

function findToolIndex(feed: FeedItem[], toolCallId: string): number | undefined {
  for (let i = feed.length - 1; i >= 0; i -= 1) {
    const item = feed[i];
    if (item.kind === "tool" && item.toolCallId === toolCallId) {
      return i;
    }
  }
  return undefined;
}

function isToolPart(part: NonNullable<OpenCodeEvent["properties"]["part"]>): boolean {
  if (
    part.callID ||
    part.tool ||
    part.toolCallId ||
    part.toolName ||
    part.input !== undefined ||
    part.output !== undefined
  ) {
    return true;
  }
  const type = part.type?.toLowerCase();
  if (!type) return false;
  return (
    type.includes("tool") ||
    type === "tool-call" ||
    type === "tool_call" ||
    type === "tool-result" ||
    type === "tool_result" ||
    type === "tool-output" ||
    type === "tool_output"
  );
}

function isToolResult(part: NonNullable<OpenCodeEvent["properties"]["part"]>): boolean {
  const type = part.type?.toLowerCase();
  return (
    (!!type && (type.includes("result") || type.includes("output"))) ||
    part.state?.status === "completed" ||
    part.state?.status === "error" ||
    part.output !== undefined ||
    part.result !== undefined ||
    part.isError === true ||
    part.error !== undefined
  );
}

export function openCodeReducer(state: OpenCodeState, event: OpenCodeEvent): OpenCodeState {
  const now = Date.now();
  const messageRoles = new Map(state.messageRoles);
  const messageIndexes = new Map(state.messageIndexes);

  switch (event.type) {
    case "message.updated": {
      const info = event.properties.info;
      if (!info) return state;
      if (info.id && info.role) {
        messageRoles.set(info.id, info.role === "user" ? "user" : "assistant");
      }
      if (info.error?.data?.message) {
        const errItem = err(info.error.data.message, now, event);
        return { ...state, feed: [...state.feed, errItem], messageRoles };
      }
      if (info.role === "user") {
        return { ...state, messageRoles, messageIndexes };
      }

      // Extract text from parts or content
      const textContent: ContentBlock[] = [];
      if (info.parts) {
        for (const part of info.parts) {
          if (part.type === "text" && part.text) {
            textContent.push({ type: "text", text: part.text });
          }
        }
      } else if (info.content) {
        textContent.push({ type: "text", text: info.content });
      }

      if (textContent.length === 0) return state;

      const messageId = info.id;
      const msgItem = msg("assistant", textContent, info.time?.created ?? now);
      if (messageId) {
        const existingIndex = messageIndexes.get(messageId);
        if (existingIndex !== undefined) {
          if (state.feed[existingIndex]?.kind === "message") {
            const feed = [...state.feed];
            feed[existingIndex] = msgItem;
            return clearStreaming({
              ...state,
              feed,
              messageRoles,
              messageIndexes,
            });
          }
          messageIndexes.delete(messageId);
        }
        const feed = [...state.feed, msgItem];
        messageIndexes.set(messageId, feed.length - 1);
        return clearStreaming({ ...state, feed, messageRoles, messageIndexes });
      }
      return clearStreaming({
        ...state,
        feed: [...state.feed, msgItem],
        messageRoles,
        messageIndexes,
      });
    }

    case "session.error": {
      const errorMessage =
        (event.properties as { error?: { data?: { message?: string } } })?.error?.data?.message ??
        "OpenCode session error";
      const errItem = err(errorMessage, now, event);
      return { ...state, feed: [...state.feed, errItem], messageRoles, messageIndexes };
    }

    case "message.part.updated": {
      const part = event.properties.part;
      if (!part) return state;

      if (part.type === "text" && part.text) {
        const messageId = part.messageID;
        const role = messageId ? messageRoles.get(messageId) : undefined;
        if (role === "user") return { ...state, messageRoles, messageIndexes };

        const ts = part.time?.start ?? now;
        const msgItem = msg("assistant", asTextContent(part.text), ts);
        if (messageId) {
          const existingIndex = messageIndexes.get(messageId);
          if (existingIndex !== undefined) {
            if (state.feed[existingIndex]?.kind === "message") {
              const feed = [...state.feed];
              feed[existingIndex] = msgItem;
              return { ...state, feed, isStreaming: true, messageRoles, messageIndexes };
            }
            messageIndexes.delete(messageId);
          }
          const feed = [...state.feed, msgItem];
          messageIndexes.set(messageId, feed.length - 1);
          return { ...state, feed, isStreaming: true, messageRoles, messageIndexes };
        }
        return {
          ...state,
          feed: [...state.feed, msgItem],
          isStreaming: true,
          messageRoles,
          messageIndexes,
        };
      }

      if (isToolPart(part)) {
        const toolCallId = part.callID ?? part.toolCallId ?? part.id;
        if (!toolCallId) return { ...state, messageRoles, messageIndexes };

        const toolName = part.tool ?? part.toolName ?? "tool";
        const input = part.state?.input ?? part.input ?? part.args ?? {};
        const output =
          part.state?.output ?? part.state?.metadata?.output ?? part.output ?? part.result;
        const isError =
          part.isError === true ||
          (typeof part.error === "string" ? true : part.error?.message != null);

        const status = part.state?.status;
        const active = state.activeTools.get(toolCallId);
        const toolIndex = active?.feedIndex ?? findToolIndex(state.feed, toolCallId);

        if (isToolResult(part)) {
          if (toolIndex === undefined) return { ...state, messageRoles, messageIndexes };
          const feed = [...state.feed];
          const updated: ToolFeedItem = {
            ...(feed[toolIndex] as ToolFeedItem),
            state: status === "error" || isError ? "error" : "completed",
            output,
            endTimestamp: part.state?.time?.end ?? now,
          };
          if (isError) {
            updated.errorText =
              typeof part.error === "string"
                ? part.error
                : (part.error?.message ?? (typeof output === "string" ? output : "Failed"));
          }
          feed[toolIndex] = updated;
          const activeTools = new Map(state.activeTools);
          activeTools.delete(toolCallId);
          return { ...state, feed, activeTools, messageRoles, messageIndexes };
        }

        if (toolIndex !== undefined) {
          const feed = [...state.feed];
          const existing = feed[toolIndex] as ToolFeedItem;
          const nextState =
            status === "running" || status === "input-available"
              ? "running"
              : status === "pending"
                ? "pending"
                : existing.state;
          feed[toolIndex] = {
            ...existing,
            state: nextState,
            input,
            output: output ?? existing.output,
          };
          const activeTools = new Map(state.activeTools);
          if (!active || active.feedIndex !== toolIndex) {
            activeTools.set(toolCallId, { feedIndex: toolIndex });
          }
          return { ...state, feed, activeTools, messageRoles, messageIndexes };
        }

        const item: ToolFeedItem = {
          kind: "tool",
          toolCallId,
          toolName,
          state: status === "running" || status === "input-available" ? "running" : "pending",
          input,
          startTimestamp: part.state?.time?.start ?? now,
        };
        const feed = [...state.feed, item];
        const activeTools = new Map(state.activeTools);
        activeTools.set(toolCallId, { feedIndex: feed.length - 1 });
        return { ...state, feed, activeTools, messageRoles, messageIndexes };
      }

      return { ...state, messageRoles, messageIndexes };
    }

    case "session.updated":
    case "session.idle":
    case "session.status":
      // Session updates arrive after assistant finishes; clear streaming indicator.
      return state.isStreaming
        ? clearStreaming({ ...state, messageRoles, messageIndexes })
        : { ...state, messageRoles, messageIndexes };

    case "file.edited":
    case "file.watcher.updated":
      // File events don't map to feed items directly
      return { ...state, messageRoles, messageIndexes };

    default:
      return { ...state, messageRoles, messageIndexes };
  }
}

export function getMessages(state: OpenCodeState): MessageFeedItem[] {
  return state.feed.filter((item): item is MessageFeedItem => item.kind === "message");
}

export function getTools(state: OpenCodeState): ToolFeedItem[] {
  return state.feed.filter((item): item is ToolFeedItem => item.kind === "tool");
}
