import { useState, memo, useCallback, useRef, useMemo } from "react";
import { useLocalStorage } from "usehooks-ts";
import { PlayIcon, PauseIcon, CodeIcon, TypeIcon } from "lucide-react";
import { HarnessErrorAlert } from "./harness-error-alert.tsx";
import { SerializedObjectCodeBlock } from "./serialized-object-code-block.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import type {
  EventFeedItem,
  FeedItem,
  MessageFeedItem,
  ToolFeedItem,
  GroupedEventFeedItem,
} from "@/reducers";
import { grokPlayAudio, grokGetAudioDuration, type AudioPlaybackHandle } from "@/reducers";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message.tsx";
import { Shimmer } from "@/components/ai-elements/shimmer.tsx";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool.tsx";
import { Badge } from "@/components/ui/badge.tsx";

function getMessageText(content: { type: string; text: string }[]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Transform XML-like tags in text into collapsible <details> elements.
 * Matches patterns like <tagname>...</tagname> and wraps them.
 */
function collapseXmlTags(text: string): string {
  // Match XML-like tags: <tagname>content</tagname> or <tagname attr="value">content</tagname>
  // Using a regex that handles multiline content
  const xmlTagPattern = /<([a-zA-Z][\w-]*)[^>]*>([\s\S]*?)<\/\1>/g;

  return text.replace(xmlTagPattern, (_match, tagName, content) => {
    const trimmedContent = content.trim();

    return `<details>
<summary><code>&lt;${tagName}&gt;</code></summary>

\`\`\`
${trimmedContent}
\`\`\`

</details>`;
  });
}

/** Format duration as m:ss */
function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

const MessageBubble = memo(function MessageBubble({
  msg,
  isStreaming,
}: {
  msg: MessageFeedItem;
  isStreaming?: boolean;
}) {
  const text = getMessageText(msg.content);
  const timeStr = new Date(msg.timestamp).toLocaleTimeString();
  const hasAudio = !!msg.audioData;

  const [isPlaying, setIsPlaying] = useState(false);
  const [showRaw, setShowRaw] = useLocalStorage("kiterate:showRawMessages", false);
  const playbackRef = useRef<AudioPlaybackHandle | null>(null);

  const duration = useMemo(
    () => (msg.audioData ? grokGetAudioDuration(msg.audioData) : 0),
    [msg.audioData],
  );

  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      // Stop playback
      playbackRef.current?.stop();
      playbackRef.current = null;
      setIsPlaying(false);
    } else if (msg.audioData) {
      // Start playback
      playbackRef.current = grokPlayAudio(msg.audioData, () => {
        setIsPlaying(false);
        playbackRef.current = null;
      });
      if (playbackRef.current) {
        setIsPlaying(true);
      }
    }
  }, [isPlaying, msg.audioData]);

  return (
    <Message from={msg.role}>
      <MessageContent>
        <div className="text-xs text-muted-foreground mb-1 flex items-center gap-2">
          <span>{msg.role === "user" ? "You" : "Assistant"}</span>
          <span>·</span>
          <span>{timeStr}</span>
          {isStreaming && <span className="animate-pulse">●</span>}
          {hasAudio && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0"
                onClick={handlePlayPause}
                title={isPlaying ? "Pause" : "Play audio"}
              >
                {isPlaying ? <PauseIcon className="h-3 w-3" /> : <PlayIcon className="h-3 w-3" />}
              </Button>
              <span className="tabular-nums">{formatDuration(duration)}</span>
            </>
          )}
          {text && (
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1 text-[10px] gap-0.5"
              onClick={() => setShowRaw(!showRaw)}
              title={showRaw ? "Show formatted" : "Show raw"}
            >
              {showRaw ? <TypeIcon className="h-3 w-3" /> : <CodeIcon className="h-3 w-3" />}
              {showRaw ? "fmt" : "raw"}
            </Button>
          )}
        </div>
        {text ? (
          showRaw ? (
            <pre className="whitespace-pre-wrap font-mono text-sm bg-muted/50 p-2 rounded overflow-x-auto">
              {text}
            </pre>
          ) : (
            <MessageResponse>{collapseXmlTags(text)}</MessageResponse>
          )
        ) : hasAudio ? (
          <span className="opacity-60 italic text-sm">[Audio message]</span>
        ) : isStreaming ? (
          <Shimmer className="text-sm">Thinking...</Shimmer>
        ) : (
          <span className="opacity-60 italic text-sm">Empty</span>
        )}
      </MessageContent>
    </Message>
  );
});

export function EventLine({ event }: { event: EventFeedItem }) {
  const [open, setOpen] = useState(false);
  const timeStr = new Date(event.timestamp).toLocaleTimeString();

  return (
    <div className="flex justify-end">
      <Button
        variant="ghost"
        size="sm"
        className="h-auto py-0.5 px-2 text-xs text-muted-foreground hover:text-foreground gap-2"
        onClick={() => setOpen(true)}
      >
        <span className="font-mono">{event.eventType}</span>
        <span>·</span>
        <span>{timeStr}</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[100vw] max-w-[100vw] h-[100vh] max-h-[100vh] sm:w-[80vw] sm:max-w-[80vw] sm:h-[80vh] sm:max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">
              {event.eventType}
              <span className="text-muted-foreground ml-2">· {timeStr}</span>
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-hidden">
            <SerializedObjectCodeBlock
              data={event.raw}
              className="h-full"
              initialFormat="yaml"
              showToggle
              showCopyButton
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Render a group of consecutive events of the same type */
export function GroupedEventLine({ group }: { group: GroupedEventFeedItem }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const firstTimeStr = new Date(group.firstTimestamp).toLocaleTimeString();
  const lastTimeStr = new Date(group.lastTimestamp).toLocaleTimeString();

  return (
    <div className="flex justify-end">
      <Button
        variant="ghost"
        size="sm"
        className="h-auto py-0.5 px-2 text-xs text-muted-foreground hover:text-foreground gap-2"
        onClick={() => setDialogOpen(true)}
      >
        <span className="font-mono">{group.eventType}</span>
        <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
          ×{group.count}
        </Badge>
        <span>·</span>
        <span>{firstTimeStr}</span>
        {firstTimeStr !== lastTimeStr && (
          <span className="text-muted-foreground/60">– {lastTimeStr}</span>
        )}
      </Button>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="w-[100vw] max-w-[100vw] h-[100vh] max-h-[100vh] sm:w-[80vw] sm:max-w-[80vw] sm:h-[80vh] sm:max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">
              {group.eventType}
              <Badge variant="secondary" className="ml-2 text-xs">
                {group.count} events
              </Badge>
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-hidden">
            <SerializedObjectCodeBlock
              data={group.events.map((e) => e.raw)}
              className="h-full"
              initialFormat="yaml"
              showToggle
              showCopyButton
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Renders a tool execution feed item using the Tool AI Element.
 */
function ToolExecution({ tool }: { tool: ToolFeedItem }) {
  // Map our ToolState to the AI SDK ToolUIPart state
  const uiState = (() => {
    switch (tool.state) {
      case "pending":
        return "input-streaming" as const;
      case "running":
        return "input-available" as const;
      case "completed":
        return "output-available" as const;
      case "error":
        return "output-error" as const;
    }
  })();

  return (
    <Tool defaultOpen={tool.state !== "completed"}>
      <ToolHeader title={tool.toolName} type="tool-invocation" state={uiState} />
      <ToolContent>
        <ToolInput input={tool.input} />
        {(tool.state === "completed" || tool.state === "error") && (
          <ToolOutput output={tool.output} errorText={tool.errorText} />
        )}
      </ToolContent>
    </Tool>
  );
}

export const FeedItemRenderer = memo(function FeedItemRenderer({
  item,
  isStreaming,
}: {
  item: FeedItem;
  isStreaming?: boolean;
}) {
  switch (item.kind) {
    case "message":
      return <MessageBubble msg={item} isStreaming={isStreaming ?? false} />;
    case "error":
      return <HarnessErrorAlert error={item} />;
    case "event":
      return <EventLine event={item} />;
    case "grouped-event":
      return <GroupedEventLine group={item} />;
    case "tool":
      return <ToolExecution tool={item} />;
    default:
      // Unknown feed item type - skip
      return null;
  }
});
