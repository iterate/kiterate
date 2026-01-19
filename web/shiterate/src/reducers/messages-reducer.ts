/**
 * Pure reducer for transforming Pi agent events into a unified feed.
 * This module has no side effects and can be easily unit tested.
 *
 * Events come in two forms:
 * 1. Action events: { type: "iterate:agent:harness:pi:action:...", payload: {...} }
 * 2. Pi SDK events wrapped: { type: "iterate:agent:harness:pi:event-received", payload: { piEventType: "...", piEvent: {...} } }
 *
 * The feed shows full event types for UI consistency, but the reducer extracts
 * the inner piEvent when processing messages.
 *
 * AI Element Types Supported:
 * - Message: User and assistant text messages
 * - Tool: Tool execution lifecycle (start → update → end)
 * - Reasoning: Thinking/reasoning content blocks
 * - Compaction: Auto-compaction lifecycle events
 * - Retry: Auto-retry lifecycle events
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ContentBlock {
  type: string;
  text: string;
}

export interface MessageFeedItem {
  kind: "message";
  role: "user" | "assistant";
  content: ContentBlock[];
  timestamp: number;
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
 * Maps to the Tool AI Element component states.
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
  input: unknown; // tool arguments/parameters
  output?: unknown; // tool result (set on completion)
  errorText?: string; // error message if state is "error"
  startTimestamp: number;
  endTimestamp?: number;
}

/**
 * Reasoning/thinking feed item - tracks extended thinking content.
 * Maps to the Reasoning AI Element component.
 */
export interface ReasoningFeedItem {
  kind: "reasoning";
  content: string; // accumulated thinking text
  isStreaming: boolean; // true while thinking_delta events are being received
  startTimestamp: number;
  endTimestamp?: number;
  /** Duration in seconds (set when streaming ends) */
  duration?: number;
}

/**
 * Compaction feed item - tracks auto-compaction lifecycle.
 * Useful for showing compaction progress in the UI.
 */
export interface CompactionFeedItem {
  kind: "compaction";
  state: "running" | "completed" | "aborted";
  reason: "threshold" | "overflow";
  startTimestamp: number;
  endTimestamp?: number;
  /** Whether compaction will be retried (set on completion) */
  willRetry?: boolean;
}

/**
 * Retry feed item - tracks auto-retry lifecycle.
 * Useful for showing retry progress in the UI.
 */
export interface RetryFeedItem {
  kind: "retry";
  state: "waiting" | "completed" | "failed";
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
  startTimestamp: number;
  endTimestamp?: number;
  /** Final error if retry failed (set on completion) */
  finalError?: string;
}

export type FeedItem =
  | MessageFeedItem
  | EventFeedItem
  | ErrorFeedItem
  | ToolFeedItem
  | ReasoningFeedItem
  | CompactionFeedItem
  | RetryFeedItem;

/**
 * Active tool execution being tracked (before completion).
 * Used to update tool state on tool_execution_update/end events.
 */
interface ActiveToolExecution {
  toolCallId: string;
  toolName: string;
  input: unknown;
  startTimestamp: number;
  feedIndex: number; // index in feed array for updates
}

/**
 * Active reasoning block being streamed.
 */
interface ActiveReasoning {
  content: string;
  startTimestamp: number;
  feedIndex: number; // index in feed array for updates
}

export interface MessagesState {
  feed: FeedItem[];
  isStreaming: boolean;
  streamingMessage?: MessageFeedItem;
  rawEvents: unknown[];
  processedEventCount: number;
  /** Active tool executions keyed by toolCallId */
  activeTools: Map<string, ActiveToolExecution>;
  /** Active reasoning block (if streaming thinking content) */
  activeReasoning?: ActiveReasoning;
  /** Active compaction (if running) */
  activeCompaction?: { feedIndex: number; startTimestamp: number };
  /** Active retry (if waiting) */
  activeRetry?: { feedIndex: number; startTimestamp: number };
}

const PI_EVENT_RECEIVED = "iterate:agent:harness:pi:event-received";
const PI_ERROR = "iterate:agent:harness:pi:error";

// ─────────────────────────────────────────────────────────────────────────────
// Initial State
// ─────────────────────────────────────────────────────────────────────────────

export function createInitialState(): MessagesState {
  return {
    feed: [],
    isStreaming: false,
    streamingMessage: undefined,
    rawEvents: [],
    processedEventCount: 0,
    activeTools: new Map(),
    activeReasoning: undefined,
    activeCompaction: undefined,
    activeRetry: undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getTimestamp(e: Record<string, unknown>): number {
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

function createMessageItem(
  role: "user" | "assistant",
  content: ContentBlock[],
  timestamp: number,
): MessageFeedItem {
  return { kind: "message", role, content, timestamp };
}

function createEventItem(eventType: string, timestamp: number, raw: unknown): EventFeedItem {
  return { kind: "event", eventType, timestamp, raw };
}

function createErrorItem(
  message: string,
  timestamp: number,
  raw: unknown,
  context?: string,
  stack?: string,
): ErrorFeedItem {
  return { kind: "error", message, context, stack, timestamp, raw };
}

function createToolItem(
  toolCallId: string,
  toolName: string,
  state: ToolState,
  input: unknown,
  timestamp: number,
): ToolFeedItem {
  return {
    kind: "tool",
    toolCallId,
    toolName,
    state,
    input,
    startTimestamp: timestamp,
  };
}

function createReasoningItem(content: string, timestamp: number): ReasoningFeedItem {
  return {
    kind: "reasoning",
    content,
    isStreaming: true,
    startTimestamp: timestamp,
  };
}

function createCompactionItem(
  reason: "threshold" | "overflow",
  timestamp: number,
): CompactionFeedItem {
  return {
    kind: "compaction",
    state: "running",
    reason,
    startTimestamp: timestamp,
  };
}

function createRetryItem(
  attempt: number,
  maxAttempts: number,
  delayMs: number,
  errorMessage: string,
  timestamp: number,
): RetryFeedItem {
  return {
    kind: "retry",
    state: "waiting",
    attempt,
    maxAttempts,
    delayMs,
    errorMessage,
    startTimestamp: timestamp,
  };
}

/**
 * Helper to update an item at a specific index in the feed array.
 * Returns a new feed array with the updated item.
 */
function updateFeedItem<T extends FeedItem>(
  feed: FeedItem[],
  index: number,
  updater: (item: T) => T,
): FeedItem[] {
  const newFeed = [...feed];
  newFeed[index] = updater(newFeed[index] as T);
  return newFeed;
}

/**
 * Extract the inner Pi event from a wrapped event envelope.
 * Returns the piEvent if this is a PI_EVENT_RECEIVED, otherwise null.
 */
function extractPiEvent(e: Record<string, unknown>): Record<string, unknown> | null {
  if (e.type !== PI_EVENT_RECEIVED) return null;
  const payload = e.payload as { piEvent?: unknown } | undefined;
  if (payload?.piEvent && typeof payload.piEvent === "object") {
    return payload.piEvent as Record<string, unknown>;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reducer
// ─────────────────────────────────────────────────────────────────────────────

export function messagesReducer(state: MessagesState, event: unknown): MessagesState {
  const e = event as Record<string, unknown>;
  const rawEvents = [...state.rawEvents, event];
  const timestamp = getTimestamp(e);
  const eventType = typeof e.type === "string" ? e.type : "unknown";

  // For Pi events, extract the inner event to process message content
  const piEvent = extractPiEvent(e);
  const piEventType = piEvent?.type as string | undefined;

  // Handle Pi SDK events (wrapped in event-received envelope)
  if (piEvent) {
    // ─────────────────────────────────────────────────────────────────────────
    // Tool Execution Events
    // ─────────────────────────────────────────────────────────────────────────

    if (piEventType === "tool_execution_start") {
      const toolCallId = piEvent.toolCallId as string;
      const toolName = piEvent.toolName as string;
      const args = piEvent.args;

      const toolItem = createToolItem(toolCallId, toolName, "pending", args, timestamp);
      const newFeed = [...state.feed, toolItem];
      const newActiveTools = new Map(state.activeTools);
      newActiveTools.set(toolCallId, {
        toolCallId,
        toolName,
        input: args,
        startTimestamp: timestamp,
        feedIndex: newFeed.length - 1,
      });

      return {
        ...state,
        feed: newFeed,
        activeTools: newActiveTools,
        rawEvents,
      };
    }

    if (piEventType === "tool_execution_update") {
      const toolCallId = piEvent.toolCallId as string;
      const activeTool = state.activeTools.get(toolCallId);

      if (activeTool) {
        // Update the existing tool item to "running" state
        const updatedFeed = updateFeedItem<ToolFeedItem>(
          state.feed,
          activeTool.feedIndex,
          (item) => ({
            ...item,
            state: "running",
            output: piEvent.partialResult, // Store partial result
          }),
        );

        return {
          ...state,
          feed: updatedFeed,
          rawEvents,
        };
      }

      // If no active tool found, just record as event
      return {
        ...state,
        feed: [...state.feed, createEventItem(eventType, timestamp, event)],
        rawEvents,
      };
    }

    if (piEventType === "tool_execution_end") {
      const toolCallId = piEvent.toolCallId as string;
      const isError = piEvent.isError as boolean;
      const result = piEvent.result;
      const activeTool = state.activeTools.get(toolCallId);

      if (activeTool) {
        // Update the existing tool item to completed/error state
        const updatedFeed = updateFeedItem<ToolFeedItem>(
          state.feed,
          activeTool.feedIndex,
          (item) => ({
            ...item,
            state: isError ? "error" : "completed",
            output: result,
            errorText: isError ? extractErrorText(result) : undefined,
            endTimestamp: timestamp,
          }),
        );

        const newActiveTools = new Map(state.activeTools);
        newActiveTools.delete(toolCallId);

        return {
          ...state,
          feed: updatedFeed,
          activeTools: newActiveTools,
          rawEvents,
        };
      }

      // If no active tool found, just record as event
      return {
        ...state,
        feed: [...state.feed, createEventItem(eventType, timestamp, event)],
        rawEvents,
      };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Agent Lifecycle Events
    // ─────────────────────────────────────────────────────────────────────────

    // agent_end signals the end of a turn - stop streaming and clear active state
    if (piEventType === "agent_end") {
      return {
        ...state,
        feed: [...state.feed, createEventItem(eventType, timestamp, event)],
        isStreaming: false,
        streamingMessage: undefined,
        activeReasoning: undefined, // Clear any active reasoning
        rawEvents,
      };
    }

    if (piEventType === "message_start") {
      const msg = piEvent.message as
        | { role?: string; content?: ContentBlock[]; timestamp?: number }
        | undefined;
      if (msg?.role === "assistant") {
        return {
          ...state,
          feed: [...state.feed, createEventItem(eventType, timestamp, event)],
          isStreaming: true,
          streamingMessage: createMessageItem("assistant", [], msg.timestamp ?? timestamp),
          rawEvents,
        };
      }
      return {
        ...state,
        feed: [...state.feed, createEventItem(eventType, timestamp, event)],
        rawEvents,
      };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Message Update Events (including thinking/reasoning)
    // ─────────────────────────────────────────────────────────────────────────

    if (piEventType === "message_update") {
      const assistantEvent = piEvent.assistantMessageEvent as Record<string, unknown> | undefined;
      if (!assistantEvent) return { ...state, rawEvents };

      const assistantEventType = assistantEvent.type as string | undefined;

      // Handle thinking/reasoning events from the nested assistantMessageEvent
      if (assistantEventType === "thinking_start") {
        // Create a new reasoning feed item
        const reasoningItem = createReasoningItem("", timestamp);
        const newFeed = [...state.feed, reasoningItem];

        return {
          ...state,
          feed: newFeed,
          activeReasoning: {
            content: "",
            startTimestamp: timestamp,
            feedIndex: newFeed.length - 1,
          },
          rawEvents,
        };
      }

      if (assistantEventType === "thinking_delta") {
        const delta = assistantEvent.delta as string | undefined;
        const activeReasoning = state.activeReasoning;

        if (activeReasoning && delta) {
          const newContent = activeReasoning.content + delta;
          const updatedFeed = updateFeedItem<ReasoningFeedItem>(
            state.feed,
            activeReasoning.feedIndex,
            (item) => ({
              ...item,
              content: newContent,
            }),
          );

          return {
            ...state,
            feed: updatedFeed,
            activeReasoning: {
              ...activeReasoning,
              content: newContent,
            },
            rawEvents,
          };
        }

        return { ...state, rawEvents };
      }

      if (assistantEventType === "thinking_end") {
        const activeReasoning = state.activeReasoning;
        const content = assistantEvent.content as string | undefined;

        if (activeReasoning) {
          const endTime = timestamp;
          const duration = Math.ceil((endTime - activeReasoning.startTimestamp) / 1000);

          const updatedFeed = updateFeedItem<ReasoningFeedItem>(
            state.feed,
            activeReasoning.feedIndex,
            (item) => ({
              ...item,
              content: content ?? item.content,
              isStreaming: false,
              endTimestamp: endTime,
              duration,
            }),
          );

          return {
            ...state,
            feed: updatedFeed,
            activeReasoning: undefined,
            rawEvents,
          };
        }

        return { ...state, rawEvents };
      }

      // Handle regular text streaming (text_delta, text_start, text_end)
      const partial = assistantEvent.partial as
        | { content?: unknown[]; timestamp?: number }
        | undefined;
      if (partial) {
        // Filter out thinking content for the streaming message (it's shown separately)
        const content: ContentBlock[] = Array.isArray(partial.content)
          ? partial.content
              .filter((c: unknown) => (c as Record<string, unknown>).type !== "thinking")
              .map((c: unknown) => {
                const block = c as Record<string, unknown>;
                return {
                  type: (block.type as string) || "text",
                  text: (block.text as string) || "",
                };
              })
          : [];

        return {
          ...state,
          isStreaming: true,
          streamingMessage: createMessageItem("assistant", content, partial.timestamp ?? timestamp),
          rawEvents,
        };
      }
      return { ...state, rawEvents };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Message End Events
    // ─────────────────────────────────────────────────────────────────────────

    if (piEventType === "message_end") {
      const msg = piEvent.message as
        | { role?: string; content?: unknown[]; timestamp?: number }
        | undefined;
      if ((msg?.role === "assistant" || msg?.role === "user") && Array.isArray(msg.content)) {
        // Separate text content from thinking content
        const textContent: ContentBlock[] = msg.content
          .filter((c: unknown) => (c as Record<string, unknown>).type === "text")
          .map((c: unknown) => {
            const block = c as Record<string, unknown>;
            return {
              type: "text",
              text: (block.text as string) || "",
            };
          });

        // Extract any thinking content that wasn't streamed
        const thinkingContent = msg.content.filter(
          (c: unknown) => (c as Record<string, unknown>).type === "thinking",
        );

        const newFeedItems: FeedItem[] = [createEventItem(eventType, timestamp, event)];

        // Add reasoning item if there's thinking content and we don't have an active one
        if (thinkingContent.length > 0 && !state.activeReasoning) {
          const thinkingBlock = thinkingContent[0] as { thinking?: string };
          if (thinkingBlock.thinking) {
            newFeedItems.push({
              kind: "reasoning",
              content: thinkingBlock.thinking,
              isStreaming: false,
              startTimestamp: msg.timestamp ?? timestamp,
              endTimestamp: timestamp,
            });
          }
        }

        // Add message if there's text content
        if (textContent.some((c) => c.text.trim())) {
          newFeedItems.push(createMessageItem(msg.role, textContent, msg.timestamp ?? timestamp));
        }

        return {
          ...state,
          feed: [...state.feed, ...newFeedItems],
          isStreaming: msg.role === "assistant" ? false : state.isStreaming,
          streamingMessage: msg.role === "assistant" ? undefined : state.streamingMessage,
          activeReasoning: msg.role === "assistant" ? undefined : state.activeReasoning,
          rawEvents,
        };
      }
      return {
        ...state,
        feed: [...state.feed, createEventItem(eventType, timestamp, event)],
        isStreaming: false,
        streamingMessage: undefined,
        rawEvents,
      };
    }

    if (piEventType === "turn_end") {
      return {
        ...state,
        feed: [...state.feed, createEventItem(eventType, timestamp, event)],
        isStreaming: false,
        streamingMessage: undefined,
        activeReasoning: undefined,
        rawEvents,
      };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Auto-Compaction Events
    // ─────────────────────────────────────────────────────────────────────────

    if (piEventType === "auto_compaction_start") {
      const reason = piEvent.reason as "threshold" | "overflow";
      const compactionItem = createCompactionItem(reason, timestamp);
      const newFeed = [...state.feed, compactionItem];

      return {
        ...state,
        feed: newFeed,
        activeCompaction: {
          feedIndex: newFeed.length - 1,
          startTimestamp: timestamp,
        },
        rawEvents,
      };
    }

    if (piEventType === "auto_compaction_end") {
      const aborted = piEvent.aborted as boolean;
      const willRetry = piEvent.willRetry as boolean;
      const activeCompaction = state.activeCompaction;

      if (activeCompaction) {
        const updatedFeed = updateFeedItem<CompactionFeedItem>(
          state.feed,
          activeCompaction.feedIndex,
          (item) => ({
            ...item,
            state: aborted ? "aborted" : "completed",
            endTimestamp: timestamp,
            willRetry,
          }),
        );

        return {
          ...state,
          feed: updatedFeed,
          activeCompaction: undefined,
          rawEvents,
        };
      }

      return {
        ...state,
        feed: [...state.feed, createEventItem(eventType, timestamp, event)],
        rawEvents,
      };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Auto-Retry Events
    // ─────────────────────────────────────────────────────────────────────────

    if (piEventType === "auto_retry_start") {
      const attempt = piEvent.attempt as number;
      const maxAttempts = piEvent.maxAttempts as number;
      const delayMs = piEvent.delayMs as number;
      const errorMessage = piEvent.errorMessage as string;

      const retryItem = createRetryItem(attempt, maxAttempts, delayMs, errorMessage, timestamp);
      const newFeed = [...state.feed, retryItem];

      return {
        ...state,
        feed: newFeed,
        activeRetry: {
          feedIndex: newFeed.length - 1,
          startTimestamp: timestamp,
        },
        rawEvents,
      };
    }

    if (piEventType === "auto_retry_end") {
      const success = piEvent.success as boolean;
      const finalError = piEvent.finalError as string | undefined;
      const activeRetry = state.activeRetry;

      if (activeRetry) {
        const updatedFeed = updateFeedItem<RetryFeedItem>(
          state.feed,
          activeRetry.feedIndex,
          (item) => ({
            ...item,
            state: success ? "completed" : "failed",
            endTimestamp: timestamp,
            finalError,
          }),
        );

        return {
          ...state,
          feed: updatedFeed,
          activeRetry: undefined,
          rawEvents,
        };
      }

      return {
        ...state,
        feed: [...state.feed, createEventItem(eventType, timestamp, event)],
        rawEvents,
      };
    }

    // Other Pi events (turn_start, agent_start, etc.)
    return {
      ...state,
      feed: [...state.feed, createEventItem(eventType, timestamp, event)],
      rawEvents,
    };
  }

  // Handle Pi harness error events
  if (eventType === PI_ERROR) {
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
          payload?.stack,
        ),
      ],
      rawEvents,
    };
  }

  // Non-Pi events (action events like prompt, session-create, etc.)
  // Just add them as event feed items
  return {
    ...state,
    feed: [...state.feed, createEventItem(eventType, timestamp, event)],
    rawEvents,
  };
}

/**
 * Extract error text from a tool result.
 * Tool results may be structured objects or simple strings.
 */
function extractErrorText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.message === "string") return r.message;
    if (typeof r.error === "string") return r.error;
    if (Array.isArray(r.content)) {
      const textContent = r.content.find(
        (c: unknown) => (c as Record<string, unknown>).type === "text",
      ) as { text?: string } | undefined;
      if (textContent?.text) return textContent.text;
    }
  }
  return "Tool execution failed";
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Reduce all events from a stream
// ─────────────────────────────────────────────────────────────────────────────

export function reduceEvents(events: unknown[]): MessagesState {
  return events.reduce(messagesReducer, createInitialState());
}

// ─────────────────────────────────────────────────────────────────────────────
// Selectors: Filter feed items by kind
// ─────────────────────────────────────────────────────────────────────────────

/** Get all message feed items */
export function getMessages(state: MessagesState): MessageFeedItem[] {
  return state.feed.filter((item): item is MessageFeedItem => item.kind === "message");
}

/** Get all tool execution feed items */
export function getTools(state: MessagesState): ToolFeedItem[] {
  return state.feed.filter((item): item is ToolFeedItem => item.kind === "tool");
}

/** Get all reasoning feed items */
export function getReasoning(state: MessagesState): ReasoningFeedItem[] {
  return state.feed.filter((item): item is ReasoningFeedItem => item.kind === "reasoning");
}

/** Get all compaction feed items */
export function getCompactions(state: MessagesState): CompactionFeedItem[] {
  return state.feed.filter((item): item is CompactionFeedItem => item.kind === "compaction");
}

/** Get all retry feed items */
export function getRetries(state: MessagesState): RetryFeedItem[] {
  return state.feed.filter((item): item is RetryFeedItem => item.kind === "retry");
}

/** Get all error feed items */
export function getErrors(state: MessagesState): ErrorFeedItem[] {
  return state.feed.filter((item): item is ErrorFeedItem => item.kind === "error");
}

/** Get all generic event feed items */
export function getEvents(state: MessagesState): EventFeedItem[] {
  return state.feed.filter((item): item is EventFeedItem => item.kind === "event");
}

/**
 * Get active/pending tools (tools that haven't completed yet).
 * Useful for showing progress indicators.
 */
export function getActiveTools(state: MessagesState): ToolFeedItem[] {
  return getTools(state).filter((t) => t.state === "pending" || t.state === "running");
}

/**
 * Check if there's an active reasoning block being streamed.
 */
export function isReasoningActive(state: MessagesState): boolean {
  return state.activeReasoning !== undefined;
}

/**
 * Check if there's an active compaction in progress.
 */
export function isCompactionActive(state: MessagesState): boolean {
  return state.activeCompaction !== undefined;
}

/**
 * Check if there's an active retry in progress.
 */
export function isRetryActive(state: MessagesState): boolean {
  return state.activeRetry !== undefined;
}
