import { useState } from "react";
import { RefreshCwIcon, ArchiveIcon } from "lucide-react";
import { HarnessErrorAlert } from "./harness-error-alert.tsx";
import { SerializedObjectCodeBlock } from "./serialized-object-code-block.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import type {
  EventFeedItem,
  FeedItem,
  MessageFeedItem,
  ToolFeedItem,
  ReasoningFeedItem,
  CompactionFeedItem,
  RetryFeedItem,
  GroupedEventFeedItem,
} from "@/reducers/messages-reducer.ts";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message.tsx";
import { Shimmer } from "@/components/ai-elements/shimmer.tsx";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool.tsx";
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "@/components/ai-elements/reasoning.tsx";
import { Badge } from "@/components/ui/badge.tsx";

function getMessageText(content: { type: string; text: string }[]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function MessageBubble({ msg, isStreaming }: { msg: MessageFeedItem; isStreaming?: boolean }) {
  const text = getMessageText(msg.content);
  const timeStr = new Date(msg.timestamp).toLocaleTimeString();

  return (
    <Message from={msg.role}>
      <MessageContent>
        <div className="text-xs text-muted-foreground mb-1 flex items-center gap-2">
          <span>{msg.role === "user" ? "You" : "Assistant"}</span>
          <span>·</span>
          <span>{timeStr}</span>
          {isStreaming && <span className="animate-pulse">●</span>}
        </div>
        {text ? (
          <MessageResponse>{text}</MessageResponse>
        ) : isStreaming ? (
          <Shimmer className="text-sm">Thinking...</Shimmer>
        ) : (
          <span className="opacity-60 italic text-sm">Empty</span>
        )}
      </MessageContent>
    </Message>
  );
}

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
              data={group.events.map(e => e.raw)}
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

/**
 * Renders a reasoning/thinking feed item using the Reasoning AI Element.
 */
function ReasoningBlock({ reasoning }: { reasoning: ReasoningFeedItem }) {
  return (
    <Reasoning isStreaming={reasoning.isStreaming} duration={reasoning.duration}>
      <ReasoningTrigger />
      <ReasoningContent>{reasoning.content}</ReasoningContent>
    </Reasoning>
  );
}

/**
 * Renders a compaction status indicator.
 */
function CompactionStatus({ compaction }: { compaction: CompactionFeedItem }) {
  const timeStr = new Date(compaction.startTimestamp).toLocaleTimeString();
  const stateLabel = {
    running: "Compacting context...",
    completed: "Context compacted",
    aborted: "Compaction aborted",
  }[compaction.state];

  return (
    <div className="flex items-center gap-2 py-2 px-3 text-sm text-muted-foreground">
      <ArchiveIcon className="size-4" />
      <span>{stateLabel}</span>
      <Badge variant="outline" className="text-xs">
        {compaction.reason}
      </Badge>
      <span className="text-xs">· {timeStr}</span>
      {compaction.state === "running" && <span className="animate-pulse">●</span>}
      {compaction.willRetry && (
        <Badge variant="secondary" className="text-xs">
          Will retry
        </Badge>
      )}
    </div>
  );
}

/**
 * Renders a retry status indicator.
 */
function RetryStatus({ retry }: { retry: RetryFeedItem }) {
  const timeStr = new Date(retry.startTimestamp).toLocaleTimeString();
  const stateLabel = {
    waiting: `Retrying (attempt ${retry.attempt}/${retry.maxAttempts})...`,
    completed: "Retry succeeded",
    failed: "Retry failed",
  }[retry.state];

  return (
    <div className="flex items-center gap-2 py-2 px-3 text-sm">
      <RefreshCwIcon
        className={`size-4 ${retry.state === "waiting" ? "animate-spin" : ""} ${retry.state === "failed" ? "text-destructive" : "text-muted-foreground"}`}
      />
      <span className={retry.state === "failed" ? "text-destructive" : "text-muted-foreground"}>
        {stateLabel}
      </span>
      <span className="text-xs text-muted-foreground">· {timeStr}</span>
      {retry.state === "waiting" && (
        <Badge variant="secondary" className="text-xs">
          {Math.round(retry.delayMs / 1000)}s delay
        </Badge>
      )}
      {retry.finalError && (
        <span className="text-xs text-destructive truncate max-w-[200px]" title={retry.finalError}>
          {retry.finalError}
        </span>
      )}
    </div>
  );
}

export function FeedItemRenderer({ item, isStreaming }: { item: FeedItem; isStreaming?: boolean }) {
  switch (item.kind) {
    case "message":
      return <MessageBubble msg={item} isStreaming={isStreaming} />;
    case "error":
      return <HarnessErrorAlert error={item} />;
    case "event":
      return <EventLine event={item} />;
    case "grouped-event":
      return <GroupedEventLine group={item} />;
    case "tool":
      return <ToolExecution tool={item} />;
    case "reasoning":
      return <ReasoningBlock reasoning={item} />;
    case "compaction":
      return <CompactionStatus compaction={item} />;
    case "retry":
      return <RetryStatus retry={item} />;
    default:
      // Exhaustive check - should never happen
      return null;
  }
}
