import { useState, useEffect, useMemo, useCallback } from "react";
import { CodeIcon, MessageCircleIcon, AlertCircleIcon, MicIcon } from "lucide-react";
import { FeedItemRenderer } from "./event-line";
import { SerializedObjectCodeBlock } from "./serialized-object-code-block";
import {
  wrapperReducer,
  createInitialWrapperState,
  grokPlayAudio,
  type WrapperState,
  type FeedItem,
  type EventFeedItem,
  type GroupedEventFeedItem,
  type ConnectionStatus,
} from "@/reducers";
import { useDurableStream } from "@/hooks/use-durable-stream";
import { useRawMode, type DisplayMode } from "@/hooks/use-raw-mode";
import { useJsonInput } from "@/hooks/use-json-input";
import { useAudioRecorder } from "@/hooks/use-audio-recorder";
import {
  buildAgentURL,
  createMessageEvent,
  sendMessage,
  sendRawJson,
  sendAudio,
  sendConfigEvent,
  type AiModelType,
} from "@/lib/agent-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Conversation,
  ConversationContent,
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

/** Generate a stable key for feed items - include index for uniqueness */
function getFeedItemKey(item: FeedItem, index: number): string {
  switch (item.kind) {
    case "message":
      return `msg-${item.role}-${item.timestamp}-${index}`;
    case "error":
      return `err-${item.timestamp}-${index}`;
    case "event":
      return `evt-${item.eventType}-${item.timestamp}-${index}`;
    case "grouped-event":
      return `grp-${item.eventType}-${item.firstTimestamp}-${item.lastTimestamp}`;
    case "tool":
      return `tool-${item.toolCallId}-${item.startTimestamp}`;
    default:
      return `unknown-${Date.now()}-${index}`;
  }
}

/**
 * Build display feed based on display mode.
 * - "pretty": Only non-event items (messages, tools, reasoning, etc.)
 * - "raw-pretty": Interleaved, with consecutive same-type events grouped
 * - "raw": Returns null - handled separately as a single YAML dump
 */
function buildDisplayFeed(
  feed: FeedItem[],
  _rawEvents: unknown[],
  displayMode: DisplayMode,
): FeedItem[] | null {
  // "raw" mode is handled separately - just return null to signal this
  if (displayMode === "raw") {
    return null;
  }

  if (displayMode === "pretty") {
    // Only show "pretty" items - filter out event items
    return feed.filter((item) => item.kind !== "event");
  }

  // "raw-pretty" mode: Show everything, group consecutive events of same type
  // Events are already in correct order from the store (by offset).
  // We group consecutive event items by type while preserving the overall order.

  const result: FeedItem[] = [];
  let currentGroup: { typeKey: string; events: EventFeedItem[] } | null = null;

  for (const item of feed) {
    if (item.kind === "event") {
      const typeKey = item.eventType;

      if (currentGroup && currentGroup.typeKey === typeKey) {
        currentGroup.events.push(item);
      } else {
        if (currentGroup) {
          result.push(createGroupedOrSingleEvent(currentGroup.events));
        }
        currentGroup = { typeKey, events: [item] };
      }
    } else {
      // Non-event item - flush any pending group first
      if (currentGroup) {
        result.push(createGroupedOrSingleEvent(currentGroup.events));
        currentGroup = null;
      }
      result.push(item);
    }
  }

  // Flush any remaining group
  if (currentGroup) {
    result.push(createGroupedOrSingleEvent(currentGroup.events));
  }

  return result;
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
  const [aiModel, setAiModel] = useState<AiModelType>("openai");
  const { displayMode, setRawEventsCount } = useRawMode();

  const jsonTemplate = useMemo(
    () => JSON.stringify(createMessageEvent(agentPath, "Hello!"), null, 2),
    [agentPath],
  );
  const jsonInput = useJsonInput(jsonTemplate);

  // Audio recording for voice input
  const [audioState, audioControls] = useAudioRecorder();

  // Handle push-to-talk
  const handleMicMouseDown = useCallback(() => {
    audioControls.startRecording();
  }, [audioControls]);

  const handleMicMouseUp = useCallback(async () => {
    const audioBase64 = await audioControls.stopRecording();
    if (audioBase64) {
      console.log(`[audio] Sending ${audioBase64.length} bytes of audio`);
      const result = await sendAudio(apiURL, agentPath, audioBase64);
      if (!result.ok) {
        setSendError(result.error ?? "Failed to send audio");
      }
    }
  }, [audioControls, apiURL, agentPath]);

  // Handle live events - play audio when Grok response completes
  const handleLiveEvent = useCallback(
    (event: { type: string; payload?: { type?: string } }, state: WrapperState) => {
      // Check if this is a Grok response.done event
      if (event.type === "iterate:grok:response:sse" && event.payload?.type === "response.done") {
        // Play accumulated audio chunks
        if (state.grokAudioChunks.length > 0) {
          grokPlayAudio(state.grokAudioChunks);
        }
      }
    },
    [],
  );

  const {
    state: { feed, isStreaming: stateIsStreaming, streamingMessage, rawEvents, configuredModel },
    isStreaming: hookIsStreaming,
    connectionStatus,
  } = useDurableStream<WrapperState, { type: string; [key: string]: unknown }>({
    url: buildAgentURL(apiURL, agentPath),
    storageKey: `agent:${agentPath}`,
    reducer: wrapperReducer,
    initialState: createInitialWrapperState(),
    suspense: false,
    onLiveEvent: handleLiveEvent,
  });

  // Sync AI model selector with configured model from stream history
  useEffect(() => {
    if (configuredModel) {
      setAiModel(configuredModel);
    }
  }, [configuredModel]);

  const isStreaming = stateIsStreaming || hookIsStreaming;
  const isDisabled = sending;
  const resizeBehavior = useMemo(() => ({ mass: 1, damping: 45, stiffness: 320 }), []);

  // Notify parent of connection status changes
  useEffect(() => {
    onConnectionStatusChange?.(connectionStatus);
  }, [connectionStatus, onConnectionStatusChange]);

  // Build the display feed based on display mode (null for raw-raw mode)
  const displayFeed = useMemo(
    () => buildDisplayFeed(feed, rawEvents, displayMode),
    [feed, rawEvents, displayMode],
  );

  const selectedRawEvent = useMemo(
    () => (selectedRawEventIndex !== null ? rawEvents[selectedRawEventIndex] : null),
    [selectedRawEventIndex, rawEvents],
  );

  // In raw mode, we render a single YAML dump instead of feed items
  const isRawMode = displayMode === "raw";
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

  // Handle AI model change
  const handleModelChange = async (model: AiModelType) => {
    setAiModel(model);
    setSendError(null);
    try {
      const result = await sendConfigEvent(apiURL, agentPath, model);
      if (!result.ok) {
        setSendError(result.error ?? `Failed to switch to ${model}`);
      }
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Failed to switch model");
    }
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
      <Conversation className="flex-1 min-h-0" resize={resizeBehavior}>
        <ConversationContent className={isRawMode ? "p-2" : "p-6"}>
          {isRawMode ? (
            // Raw Raw mode: render all events as a single YAML dump
            rawEvents.length === 0 ? null : (
              <SerializedObjectCodeBlock
                data={rawEvents}
                className="h-full"
                initialFormat="yaml"
                showToggle
                showCopyButton
              />
            )
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

        {/* Mode toggle, model selector, and status */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
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
            <Select value={aiModel} onValueChange={(v) => handleModelChange(v as AiModelType)}>
              <SelectTrigger className="h-8 w-[110px] text-xs">
                <SelectValue placeholder="Model" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">OpenAI</SelectItem>
                <SelectItem value="grok">Grok</SelectItem>
              </SelectContent>
            </Select>
          </div>
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
              <div className="flex items-center gap-2">
                <PromptInputTools />
                {audioState.isSupported && (
                  <>
                    {audioState.devices.length > 1 && (
                      <Select
                        value={audioState.selectedDeviceId ?? undefined}
                        onValueChange={audioControls.selectDevice}
                      >
                        <SelectTrigger className="h-8 w-[140px] text-xs">
                          <SelectValue placeholder="Microphone" />
                        </SelectTrigger>
                        <SelectContent>
                          {audioState.devices.map((device) => (
                            <SelectItem key={device.deviceId} value={device.deviceId}>
                              {device.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <Button
                      variant={audioState.isRecording ? "destructive" : "ghost"}
                      size="icon"
                      className="size-8"
                      onMouseDown={handleMicMouseDown}
                      onMouseUp={handleMicMouseUp}
                      onMouseLeave={handleMicMouseUp}
                      onTouchStart={handleMicMouseDown}
                      onTouchEnd={handleMicMouseUp}
                      disabled={isDisabled}
                      title="Hold to record audio"
                    >
                      <MicIcon className="size-4" />
                    </Button>
                  </>
                )}
              </div>
              <PromptInputSubmit
                disabled={isDisabled}
                {...(sending
                  ? { status: "submitted" as const }
                  : isStreaming
                    ? { status: "streaming" as const }
                    : {})}
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
