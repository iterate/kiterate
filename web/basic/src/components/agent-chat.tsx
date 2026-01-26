import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { CodeIcon, MessageCircleIcon, AlertCircleIcon, MicIcon, SearchIcon } from "lucide-react";
import dedent from "dedent";
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
  const [aiModel, setAiModel] = useState<AiModelType | null>(null);
  const [searchToolRegistered, setSearchToolRegistered] = useState(false);
  const [deepResearchToolRegistered, setDeepResearchToolRegistered] = useState(false);
  const { displayMode, setRawEventsCount } = useRawMode();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
  const noModelSelected = aiModel === null;
  const isDisabled = sending || noModelSelected;
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

  // Handle registering the Exa search tool
  const handleRegisterSearchTool = async () => {
    setSendError(null);
    try {
      const toolEvent = {
        type: "iterate:codemode:tool-registered",
        payload: {
          name: "exaSearch",
          description:
            "Search the web using Exa AI. Returns titles, URLs, and snippets from search results. Use this when you need to find information on the internet.",
          parametersJsonSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "The search query" },
              numResults: {
                type: "number",
                description: "Number of results to return (default: 10, max: 100)",
              },
            },
            required: ["query"],
            additionalProperties: false,
          },
          returnDescription: "Array of search results with title, url, and snippet",
          implementation: dedent`
            const response = await fetch("https://api.exa.ai/search", {
              method: "POST",
              headers: {
                "x-api-key": process.env.EXA_API_KEY,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                query: params.query,
                numResults: params.numResults || 10,
                text: true,
              }),
            });
            if (!response.ok) {
              throw new Error("Exa search failed: " + response.status + " " + (await response.text()));
            }
            const data = await response.json();
            return data.results.map(r => ({
              title: r.title,
              url: r.url,
              snippet: r.text?.slice(0, 500),
            }));
          `,
        },
      };
      const result = await sendRawJson(apiURL, agentPath, JSON.stringify(toolEvent));
      if (!result.ok) {
        setSendError(result.error ?? "Failed to register Exa search tool");
      } else {
        setSearchToolRegistered(true);
      }
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Failed to register tool");
    }
  };

  // Handle registering the Parallel AI deep research tools (start, check, and sleep)
  const handleRegisterDeepResearchTool = async () => {
    setSendError(null);
    try {
      // Tool 1: Start deep research (returns immediately with run ID)
      const startResearchEvent = {
        type: "iterate:codemode:tool-registered",
        payload: {
          name: "startDeepResearch",
          description:
            "Start a comprehensive deep research task on any topic using Parallel AI. This initiates multi-step web exploration and returns immediately with a run ID. Use checkResearchStatus to poll for results. Use this for complex research questions that require synthesizing information from multiple sources.",
          parametersJsonSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  "The research question or topic to investigate. Be specific and detailed for better results.",
              },
              processor: {
                type: "string",
                enum: ["pro-fast", "pro", "ultra-fast", "ultra"],
                description:
                  "The processor to use. 'pro-fast' (default) and 'ultra-fast' are faster (1-3 min). 'pro' and 'ultra' are more thorough but slower (5-15 min).",
              },
            },
            required: ["query"],
            additionalProperties: false,
          },
          returnDescription: "Object with runId to use with checkResearchStatus",
          implementation: dedent`
            const processor = params.processor || "pro-fast";
            
            const response = await fetch("https://api.parallel.ai/v1/tasks/runs", {
              method: "POST",
              headers: {
                "Authorization": "Bearer " + process.env.PARALLEL_AI_API_KEY,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                input: params.query,
                processor: processor,
                task_spec: { output_schema: { type: "text" } }
              }),
            });
            
            if (!response.ok) {
              throw new Error("Failed to create research task: " + response.status + " " + (await response.text()));
            }
            
            const task = await response.json();
            return {
              runId: task.run_id,
              status: "running",
              processor: processor,
              message: "Research started. Use checkResearchStatus with this runId to check progress. Consider using sleep for 30-60 seconds before checking.",
            };
          `,
        },
      };

      // Tool 2: Check research status (quick status check only)
      const checkResearchEvent = {
        type: "iterate:codemode:tool-registered",
        payload: {
          name: "checkResearchStatus",
          description:
            "Check the status of a deep research task. Returns 'running', 'completed', or 'failed'. When completed, use getResearchResult to fetch the full report.",
          parametersJsonSchema: {
            type: "object",
            properties: {
              runId: {
                type: "string",
                description: "The run ID returned by startDeepResearch",
              },
            },
            required: ["runId"],
            additionalProperties: false,
          },
          returnDescription: "Status object with 'status' field ('running', 'completed', 'failed')",
          implementation: dedent`
            const response = await fetch("https://api.parallel.ai/v1/tasks/runs/" + params.runId, {
              headers: { "Authorization": "Bearer " + process.env.PARALLEL_AI_API_KEY },
            });
            
            if (!response.ok) {
              throw new Error("Failed to check task status: " + response.status + " " + (await response.text()));
            }
            
            const result = await response.json();
            console.log("Research status:", result.status);
            
            if (result.status === "completed") {
              return {
                status: "completed",
                runId: params.runId,
                message: "Research complete! Use getResearchResult to fetch the full report.",
              };
            } else if (result.status === "failed") {
              return {
                status: "failed",
                error: result.error || "Unknown error",
                runId: params.runId,
              };
            } else {
              return {
                status: "running",
                runId: params.runId,
                message: "Research is still in progress. Try again in 30-60 seconds.",
              };
            }
          `,
        },
      };

      // Tool 3: Get research result (fetches the full report)
      const getResearchResultEvent = {
        type: "iterate:codemode:tool-registered",
        payload: {
          name: "getResearchResult",
          description:
            "Fetch the full research report for a completed deep research task. Only call this after checkResearchStatus returns 'completed'.",
          parametersJsonSchema: {
            type: "object",
            properties: {
              runId: {
                type: "string",
                description: "The run ID returned by startDeepResearch",
              },
            },
            required: ["runId"],
            additionalProperties: false,
          },
          returnDescription: "The full research report as markdown with citations",
          implementation: dedent`
            const response = await fetch("https://api.parallel.ai/v1/tasks/runs/" + params.runId + "/result", {
              headers: { "Authorization": "Bearer " + process.env.PARALLEL_AI_API_KEY },
            });
            
            if (!response.ok) {
              throw new Error("Failed to get research result: " + response.status + " " + (await response.text()));
            }
            
            const data = await response.json();
            return {
              runId: params.runId,
              report: data.output,
            };
          `,
        },
      };

      // Tool 3: Sleep (for pacing async operations)
      const sleepEvent = {
        type: "iterate:codemode:tool-registered",
        payload: {
          name: "sleep",
          description:
            "Wait for a specified duration. Useful for pacing async operations like waiting for research to complete. Use this between checkResearchStatus calls.",
          parametersJsonSchema: {
            type: "object",
            properties: {
              seconds: {
                type: "number",
                description: "Number of seconds to wait (max 120)",
              },
              reason: {
                type: "string",
                description: "Why you are waiting (for logging purposes)",
              },
            },
            required: ["seconds"],
            additionalProperties: false,
          },
          returnDescription: "Confirmation that the sleep completed",
          implementation: dedent`
            const seconds = Math.min(params.seconds, 120); // Cap at 2 minutes
            console.log("Sleeping for " + seconds + " seconds" + (params.reason ? ": " + params.reason : ""));
            await new Promise(resolve => setTimeout(resolve, seconds * 1000));
            return { slept: seconds, reason: params.reason || "unspecified" };
          `,
        },
      };

      // Register all four tools
      const results = await Promise.all([
        sendRawJson(apiURL, agentPath, JSON.stringify(startResearchEvent)),
        sendRawJson(apiURL, agentPath, JSON.stringify(checkResearchEvent)),
        sendRawJson(apiURL, agentPath, JSON.stringify(getResearchResultEvent)),
        sendRawJson(apiURL, agentPath, JSON.stringify(sleepEvent)),
      ]);

      const allOk = results.every((r) => r.ok);
      if (!allOk) {
        setSendError("Failed to register one or more research tools");
      } else {
        setDeepResearchToolRegistered(true);
      }
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Failed to register tools");
    }
  };

  // Handle AI model change - always sends config event to server
  const handleModelChange = async (model: AiModelType) => {
    const previousModel = aiModel;
    setAiModel(model);
    setSendError(null);
    try {
      const result = await sendConfigEvent(apiURL, agentPath, model);
      if (!result.ok) {
        setSendError(result.error ?? `Failed to switch to ${model}`);
        // Revert on error
        setAiModel(previousModel);
      }
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Failed to switch model");
      setAiModel(previousModel);
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
        {/* Model selection prompt */}
        {noModelSelected && (
          <div className="flex items-center gap-2 p-3 text-sm text-amber-600 bg-amber-500/10 border border-amber-500/20 rounded-md">
            <AlertCircleIcon className="size-4 shrink-0" />
            <span>Select an AI model below to start chatting</span>
          </div>
        )}

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
            <div className={`flex ${noModelSelected ? "animate-pulse" : ""}`}>
              <Button
                variant={aiModel === "openai" ? "default" : "outline"}
                size="sm"
                className="h-8 text-xs rounded-r-none"
                disabled={aiModel === "openai"}
                onClick={() => handleModelChange("openai")}
              >
                OpenAI
              </Button>
              <Button
                variant={aiModel === "grok" ? "default" : "outline"}
                size="sm"
                className="h-8 text-xs rounded-l-none border-l-0"
                disabled={aiModel === "grok"}
                onClick={() => handleModelChange("grok")}
              >
                Grok
              </Button>
            </div>
            <Button
              variant={searchToolRegistered ? "secondary" : "outline"}
              size="sm"
              className="h-8 text-xs gap-1"
              disabled={searchToolRegistered}
              onClick={handleRegisterSearchTool}
              title="Add Exa web search tool"
            >
              <SearchIcon className="size-3" />
              {searchToolRegistered ? "Search Added" : "Add Search"}
            </Button>
            <Button
              variant={deepResearchToolRegistered ? "secondary" : "outline"}
              size="sm"
              className="h-8 text-xs gap-1"
              disabled={deepResearchToolRegistered}
              onClick={handleRegisterDeepResearchTool}
              title="Add Parallel AI deep research tool"
            >
              <SearchIcon className="size-3" />
              {deepResearchToolRegistered ? "Research Added" : "Add Research"}
            </Button>
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
            <PromptInputTextarea
              ref={textareaRef}
              placeholder="Type a message..."
              disabled={isDisabled}
              autoFocus
            />
            <PromptInputFooter>
              <div className="flex items-center gap-2">
                {audioState.isSupported && (
                  <>
                    {audioState.devices.length > 1 && (
                      <Select
                        value={audioState.selectedDeviceId ?? ""}
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
