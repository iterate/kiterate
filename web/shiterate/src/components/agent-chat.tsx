import { useState, useEffect, useMemo } from "react";
import { MessageSquareIcon, CodeIcon, MessageCircleIcon, AlertCircleIcon } from "lucide-react";
import { FeedItemRenderer } from "./event-line";
import { SerializedObjectCodeBlock } from "./serialized-object-code-block";
import {
  messagesReducer,
  createInitialState,
  type MessagesState,
  type FeedItem,
  type EventFeedItem,
  type GroupedEventFeedItem,
} from "@/reducers/messages-reducer";
import { usePersistentStream, excludeTypes, type ConnectionStatus } from "@/reducers/durable-stream-reducer";
import { useRawMode, type DisplayMode } from "@/hooks/use-raw-mode";
import { useJsonInput } from "@/hooks/use-json-input";
import {
  buildAgentURL,
  createMessageEvent,
  sendMessage,
  sendRawJson,
} from "@/lib/agent-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputSubmit,
  PromptInputFooter,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Loader } from "@/components/ai-elements/loader";

type InputMode = "message" | "json";

export interface AgentChatProps {
  agentPath: string;
  apiURL: string;
  onConnectionStatusChange?: (status: ConnectionStatus) => void;
}

/** Generate a stable key for feed items */
function getFeedItemKey(item: FeedItem, index: number): string {
  switch (item.kind) {
    case "message":
      return `msg-${item.role}-${item.timestamp}-${index}`;
    case "error":
      return `err-${item.timestamp}-${index}`;
    case "event":
      return `evt-${item.eventType}-${item.timestamp}-${index}`;
    case "grouped-event":
      return `grp-${item.eventType}-${item.firstTimestamp}-${index}`;
    case "tool":
      return `tool-${item.toolCallId}-${item.startTimestamp}`;
    case "reasoning":
      return `reasoning-${item.startTimestamp}-${index}`;
    case "compaction":
      return `compaction-${item.startTimestamp}-${index}`;
    case "retry":
      return `retry-${item.attempt}-${item.startTimestamp}`;
    default:
      return `unknown-${index}`;
  }
}

/** Extract timestamp from an event object */
function getEventTimestamp(e: Record<string, unknown>): number {
  if (typeof e.createdAt === "string") {
    const parsed = Date.parse(e.createdAt);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (typeof e.timestamp === "number") return e.timestamp;
  if (typeof e.timestamp === "string") {
    const parsed = Date.parse(e.timestamp);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

/** Get event type from raw event - uses only top-level type for grouping */
function getEventTypeKey(event: unknown): string {
  if (typeof event !== "object" || event === null) return "unknown";
  const record = event as Record<string, unknown>;
  return typeof record.type === "string" ? record.type : "unknown";
}

/** Get timestamp from a feed item */
function getItemTimestamp(item: FeedItem): number {
  switch (item.kind) {
    case "message":
    case "error":
    case "event":
      return item.timestamp;
    case "tool":
    case "reasoning":
    case "compaction":
    case "retry":
      return item.startTimestamp;
    case "grouped-event":
      return item.firstTimestamp;
    default:
      return Date.now();
  }
}

/** Convert raw event to feed item format */
function toRawEventItem(event: unknown): EventFeedItem {
  if (typeof event !== "object" || event === null) {
    return { kind: "event", eventType: "unknown", timestamp: Date.now(), raw: event };
  }
  const record = event as Record<string, unknown>;
  return {
    kind: "event",
    eventType: typeof record.type === "string" ? record.type : "unknown",
    timestamp: getEventTimestamp(record),
    raw: event,
  };
}

/**
 * Build display feed based on display mode.
 * - "pretty": Only non-event items (messages, tools, reasoning, etc.)
 * - "raw": Only raw events as EventFeedItems  
 * - "raw-pretty": Interleaved, with consecutive same-type events grouped
 * - "raw-raw": Returns null - handled separately as a single YAML dump
 */
function buildDisplayFeed(
  feed: FeedItem[],
  rawEvents: unknown[],
  displayMode: DisplayMode
): FeedItem[] | null {
  // "raw-raw" mode is handled separately - just return null to signal this
  if (displayMode === "raw-raw") {
    return null;
  }

  if (displayMode === "pretty") {
    // Only show "pretty" items - filter out event items
    return feed.filter((item) => item.kind !== "event");
  }

  if (displayMode === "raw") {
    // Only raw events - convert all rawEvents to EventFeedItems
    return rawEvents.map(toRawEventItem);
  }

  // "raw-pretty" mode: Show everything, group consecutive events of same type
  // Group raw events FIRST based on their original order (not affected by pretty items)
  // Then interleave groups with pretty items by timestamp
  
  // First, get all raw events as EventFeedItems
  const allRawEvents = rawEvents.map(toRawEventItem);
  
  // Get the pretty items (non-event items) from feed
  const prettyItems = feed.filter((item) => item.kind !== "event");
  
  // Group consecutive raw events by type (in their original order)
  const rawGroups: FeedItem[] = [];
  let currentGroup: { typeKey: string; events: EventFeedItem[] } | null = null;
  
  for (const event of allRawEvents) {
    const typeKey = getEventTypeKey(event.raw);
    
    if (currentGroup && currentGroup.typeKey === typeKey) {
      currentGroup.events.push(event);
    } else {
      if (currentGroup) {
        rawGroups.push(createGroupedOrSingleEvent(currentGroup.events));
      }
      currentGroup = { typeKey, events: [event] };
    }
  }
  
  if (currentGroup) {
    rawGroups.push(createGroupedOrSingleEvent(currentGroup.events));
  }
  
  // Now interleave raw groups with pretty items by timestamp
  type TimestampedItem = { timestamp: number; item: FeedItem };
  const timestampedItems: TimestampedItem[] = [
    ...rawGroups.map((item) => {
      const ts = item.kind === "grouped-event" ? item.firstTimestamp : 
                 item.kind === "event" ? item.timestamp : Date.now();
      return { timestamp: ts, item };
    }),
    ...prettyItems.map((item) => {
      const ts = getItemTimestamp(item);
      return { timestamp: ts, item };
    }),
  ];
  
  timestampedItems.sort((a, b) => a.timestamp - b.timestamp);
  return timestampedItems.map(({ item }) => item);
}

/** Create a grouped event or single event depending on count */
function createGroupedOrSingleEvent(events: EventFeedItem[]): FeedItem {
  if (events.length === 1) {
    return events[0];
  }
  
  const grouped: GroupedEventFeedItem = {
    kind: "grouped-event",
    eventType: events[0].eventType,
    count: events.length,
    events,
    firstTimestamp: events[0].timestamp,
    lastTimestamp: events[events.length - 1].timestamp,
  };
  return grouped;
}

export function AgentChat({ agentPath, apiURL, onConnectionStatusChange }: AgentChatProps) {
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [selectedRawEventIndex, setSelectedRawEventIndex] = useState<number | null>(null);
  const [inputMode, setInputMode] = useState<InputMode>("message");
  const { displayMode, setRawEventsCount } = useRawMode();

  const jsonTemplate = useMemo(
    () => JSON.stringify(createMessageEvent(agentPath, "Hello!"), null, 2),
    [agentPath]
  );
  const jsonInput = useJsonInput(jsonTemplate);

  const {
    state: { feed, isStreaming: stateIsStreaming, streamingMessage, rawEvents },
    isStreaming: hookIsStreaming,
    connectionStatus,
  } = usePersistentStream<MessagesState, { type: string; [key: string]: unknown }>({
    url: buildAgentURL(apiURL, agentPath),
    storageKey: `agent:${agentPath}`,
    reducer: messagesReducer,
    initialState: createInitialState(),
    shouldPersist: excludeTypes("message_update"),
    suspense: false,
  });

  const isStreaming = stateIsStreaming || hookIsStreaming;
  const isDisabled = sending;

  // Notify parent of connection status changes
  useEffect(() => {
    onConnectionStatusChange?.(connectionStatus);
  }, [connectionStatus, onConnectionStatusChange]);

  // Build the display feed based on display mode (null for raw-raw mode)
  const displayFeed = useMemo(
    () => buildDisplayFeed(feed, rawEvents, displayMode),
    [feed, rawEvents, displayMode]
  );

  const selectedRawEvent = useMemo(
    () => (selectedRawEventIndex !== null ? rawEvents[selectedRawEventIndex] : null),
    [selectedRawEventIndex, rawEvents]
  );

  // In raw-raw mode, we render a single YAML dump instead of feed items
  const isRawRawMode = displayMode === "raw-raw";
  const isEmpty = !isRawRawMode && (displayFeed?.length === 0) && !streamingMessage;

  // Sync raw events count to context
  useEffect(() => {
    setRawEventsCount(rawEvents.length);
  }, [rawEvents.length, setRawEventsCount]);

  // Handle mode switching
  const handleModeChange = (mode: string) => {
    if (mode !== "message" && mode !== "json") return;
    setInputMode(mode);
    if (mode === "json") {
      jsonInput.reset(jsonTemplate);
    }
    setSendError(null);
  };

  const handleSubmit = async ({ text }: { text: string }) => {
    if (sending) return;
    setSendError(null);

    try {
      if (inputMode === "json") {
        if (!jsonInput.isValid) return;
        setSending(true);
        const result = await sendRawJson(apiURL, agentPath, jsonInput.value);
        if (!result.ok) {
          setSendError(result.error ?? "Failed to send JSON");
          return;
        }
        jsonInput.reset(JSON.stringify(createMessageEvent(agentPath, ""), null, 2));
      } else {
        const trimmedText = text.trim();
        if (!trimmedText) return;
        setSending(true);
        const result = await sendMessage(apiURL, agentPath, trimmedText);
        if (!result.ok) {
          setSendError(result.error ?? "Failed to send message");
        }
      }
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "An unexpected error occurred");
    } finally {
      setSending(false);
    }
  };

  const handleJsonSubmit = async () => {
    if (sending || !jsonInput.isValid) return;
    setSendError(null);

    try {
      setSending(true);
      const result = await sendRawJson(apiURL, agentPath, jsonInput.value);
      if (!result.ok) {
        setSendError(result.error ?? "Failed to send JSON");
        return;
      }
      jsonInput.reset(JSON.stringify(createMessageEvent(agentPath, ""), null, 2));
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "An unexpected error occurred");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <Conversation className="flex-1 min-h-0">
        <ConversationContent className={isRawRawMode ? "p-2" : "p-6"}>
          {isRawRawMode ? (
            // Raw Raw mode: render all events as a single YAML dump
            rawEvents.length === 0 ? (
              <ConversationEmptyState
                icon={<MessageSquareIcon className="size-10" />}
                title="No events yet"
              />
            ) : (
              <SerializedObjectCodeBlock
                data={rawEvents}
                className="h-full"
                initialFormat="yaml"
                showToggle
                showCopyButton
              />
            )
          ) : isEmpty ? (
            <ConversationEmptyState
              icon={<MessageSquareIcon className="size-10" />}
              title="No events yet"
            />
          ) : (
            <>
              {displayFeed?.map((item, index) => (
                <FeedItemRenderer key={getFeedItemKey(item, index)} item={item} />
              ))}
              {streamingMessage && (
                <FeedItemRenderer key="streaming" item={streamingMessage} isStreaming />
              )}
            </>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <footer className="p-4 border-t space-y-3">
        {/* Error display */}
        {sendError && (
          <div className="flex items-center gap-2 p-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md">
            <AlertCircleIcon className="size-4 shrink-0" />
            <span className="flex-1">{sendError}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-auto p-1 text-destructive hover:text-destructive"
              onClick={() => setSendError(null)}
            >
              Dismiss
            </Button>
          </div>
        )}

        {/* Mode toggle and status */}
        <div className="flex items-center justify-between">
          <Tabs value={inputMode} onValueChange={handleModeChange}>
            <TabsList className="h-8">
              <TabsTrigger value="message" className="text-xs gap-1 px-2">
                <MessageCircleIcon className="size-3" />
                Message
              </TabsTrigger>
              <TabsTrigger value="json" className="text-xs gap-1 px-2">
                <CodeIcon className="size-3" />
                JSON
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-2">
            {isStreaming && (
              <div className="flex items-center gap-2">
                <Loader size={14} />
                <Badge variant="secondary" className="animate-pulse">
                  Streaming
                </Badge>
              </div>
            )}
          </div>
        </div>

        {/* Input area */}
        {inputMode === "message" ? (
          <PromptInput onSubmit={handleSubmit} className="relative">
            <PromptInputTextarea placeholder="Type a message..." disabled={isDisabled} autoFocus />
            <PromptInputFooter>
              <PromptInputTools />
              <PromptInputSubmit
                disabled={isDisabled}
                status={sending ? "submitted" : isStreaming ? "streaming" : undefined}
              />
            </PromptInputFooter>
          </PromptInput>
        ) : (
          <div className="space-y-2">
            <div className="relative">
              <Textarea
                value={jsonInput.value}
                onChange={(e) => jsonInput.setValue(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    handleJsonSubmit();
                  }
                }}
                disabled={isDisabled}
                className="h-48 font-mono text-xs bg-muted/50 resize-none"
                placeholder="Enter JSON event..."
                spellCheck={false}
              />
              {jsonInput.error && (
                <div className="absolute bottom-2 left-3 right-3">
                  <Badge variant="destructive" className="text-xs">
                    {jsonInput.error}
                  </Badge>
                </div>
              )}
            </div>
            <div className="flex justify-end">
              <Button
                onClick={handleJsonSubmit}
                disabled={isDisabled || !jsonInput.isValid}
                size="sm"
              >
                {sending ? "Sending..." : "Send JSON"}
              </Button>
            </div>
          </div>
        )}
      </footer>

      <Dialog
        open={selectedRawEventIndex !== null}
        onOpenChange={(open) => !open && setSelectedRawEventIndex(null)}
      >
        <DialogContent className="w-screen max-w-screen h-screen max-h-screen sm:w-[80vw] sm:max-w-[80vw] sm:h-[80vh] sm:max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">
              Raw Event {selectedRawEventIndex !== null ? `#${selectedRawEventIndex + 1}` : ""}
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-hidden">
            {selectedRawEvent !== null && (
              <SerializedObjectCodeBlock
                data={selectedRawEvent}
                className="h-full"
                initialFormat="yaml"
                showToggle
                showCopyButton
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
