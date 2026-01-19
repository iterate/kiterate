import { useState } from "react";
import { MessageSquareIcon } from "lucide-react";
import { FeedItemRenderer } from "./event-line.tsx";
import { SerializedObjectCodeBlock } from "./serialized-object-code-block.tsx";
import {
  messagesReducer,
  createInitialState,
  type MessagesState,
  type FeedItem,
  type EventFeedItem,
} from "@/reducers/messages-reducer.ts";
import { usePersistentStream, excludeTypes } from "@/reducers/persistent-stream-reducer.ts";
import { useRawMode } from "@/hooks/use-raw-mode.ts";
import { Badge } from "@/components/ui/badge.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation.tsx";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputSubmit,
  PromptInputFooter,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input.tsx";
import { Loader } from "@/components/ai-elements/loader.tsx";

function buildAgentURL(apiURL: string, agentPath: string): string {
  return new URL(`/agents/${encodeURIComponent(agentPath)}`, apiURL).toString();
}

async function sendMessage(apiURL: string, agentPath: string, text: string): Promise<boolean> {
  const res = await fetch(buildAgentURL(apiURL, agentPath), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "message", message: text }),
  });
  return res.ok;
}

function getFeedItemKey(item: FeedItem): string {
  switch (item.kind) {
    case "message":
      return `msg-${item.role}-${item.timestamp}`;
    case "error":
      return `err-${item.timestamp}`;
    case "event":
      return `evt-${item.eventType}-${item.timestamp}`;
    case "tool":
      return `tool-${item.toolCallId}-${item.startTimestamp}`;
    case "reasoning":
      return `reasoning-${item.startTimestamp}`;
    case "compaction":
      return `compaction-${item.startTimestamp}`;
    case "retry":
      return `retry-${item.attempt}-${item.startTimestamp}`;
    default:
      // Exhaustive check
      return `unknown-${Date.now()}`;
  }
}

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

function toRawEventItem(event: unknown): EventFeedItem {
  const record = event as Record<string, unknown>;
  return {
    kind: "event",
    eventType: typeof record.type === "string" ? record.type : "unknown",
    timestamp: getEventTimestamp(record),
    raw: event,
  };
}

export function AgentChat({ agentPath, apiURL }: { agentPath: string; apiURL: string }) {
  const [sending, setSending] = useState(false);
  const [selectedRawEventIndex, setSelectedRawEventIndex] = useState<number | null>(null);
  const { rawMode, setRawEventsCount } = useRawMode();

  const isDisabled = sending;

  const {
    state: { feed, isStreaming: stateIsStreaming, streamingMessage, rawEvents },
    isStreaming: hookIsStreaming,
    offset,
  } = usePersistentStream<MessagesState, { type: string; [key: string]: unknown }>({
    url: buildAgentURL(apiURL, agentPath),
    storageKey: `agent:${agentPath}`,
    reducer: messagesReducer,
    initialState: createInitialState(),
    shouldPersist: excludeTypes("message_update"),
    suspense: false,
  });

  const isStreaming = stateIsStreaming || hookIsStreaming;
  const selectedRawEvent =
    selectedRawEventIndex !== null ? (rawEvents[selectedRawEventIndex] as unknown) : null;
  const hasEventItems = feed.some((item) => item.kind === "event");
  const rawEventItems = rawMode && !hasEventItems ? rawEvents.map(toRawEventItem) : [];
  const filteredFeed = rawMode
    ? [...feed, ...rawEventItems]
    : feed.filter((item) => item.kind !== "event");

  setRawEventsCount(rawEvents.length);

  const handleSubmit = async ({ text }: { text: string }) => {
    const trimmedText = text.trim();
    if (!trimmedText || sending) return;
    setSending(true);
    await sendMessage(apiURL, agentPath, trimmedText);
    setSending(false);
  };

  const isEmpty = filteredFeed.length === 0 && !streamingMessage;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <Conversation className="flex-1 min-h-0">
        <ConversationContent className="p-6">
          {isEmpty ? (
            <ConversationEmptyState
              icon={<MessageSquareIcon className="size-10" />}
              title="No messages yet"
              description="Start a conversation with your agent"
            />
          ) : (
            <>
              {filteredFeed.map((item) => (
                <FeedItemRenderer key={getFeedItemKey(item)} item={item} />
              ))}
              {streamingMessage && (
                <FeedItemRenderer key="streaming" item={streamingMessage} isStreaming />
              )}
            </>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <footer className="p-4 border-t">
        <PromptInput onSubmit={handleSubmit} className="relative">
          <PromptInputTextarea placeholder="Type a message..." disabled={isDisabled} autoFocus />
          <PromptInputFooter>
            <PromptInputTools>
              {isStreaming && (
                <div className="flex items-center gap-2">
                  <Loader size={14} />
                  <Badge variant="secondary" className="animate-pulse">
                    Streaming
                  </Badge>
                </div>
              )}
              {offset && (
                <span className="text-muted-foreground text-xs" title={`Offset: ${offset}`}>
                  Offset: {offset}
                </span>
              )}
            </PromptInputTools>
            <PromptInputSubmit
              disabled={isDisabled}
              status={sending ? "submitted" : isStreaming ? "streaming" : undefined}
            />
          </PromptInputFooter>
        </PromptInput>
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
