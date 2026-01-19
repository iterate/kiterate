/**
 * Simple Stream Reducer
 *
 * A React hook that consumes an SSE endpoint.
 * Events are expected to include an "offset" field.
 * No control events - just data events.
 */

import { useReducer, useEffect, useRef, useState, useCallback } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface StreamEvent {
  type: string;
  offset?: string;
  [key: string]: unknown;
}

export interface PersistentStreamConfig<TState, TEvent extends StreamEvent> {
  /** SSE endpoint URL. Pass null to disable. */
  url: string | null;

  /** Reducer: (state, event) => newState */
  reducer: (state: TState, event: TEvent) => TState;

  /** Initial state before any events */
  initialState: TState;

  /** Storage key prefix (kept for API compatibility, not used) */
  storageKey: string;

  /**
   * Filter for persistence (kept for API compatibility, not used).
   * @default () => true
   */
  shouldPersist?: (event: TEvent) => boolean;

  /**
   * Events to process per batch (kept for API compatibility, not used).
   * @default 100
   */
  replayBatchSize?: number;

  /** Called when stream catches up to live */
  onCaughtUp?: () => void;

  /** Called when server signals data is stale */
  onMustRefetch?: () => void;

  /**
   * Whether to use Suspense integration.
   * @default true
   */
  suspense?: boolean;
}

export type ConnectionStatus =
  | { state: "connecting" }
  | { state: "connected" }
  | { state: "error"; message: string }
  | { state: "closed" };

export interface PersistentStreamResult<TState> {
  /** Current reduced state */
  state: TState;

  /** True while receiving streaming events (e.g., LLM tokens) */
  isStreaming: boolean;

  /** Clear state and reload (just reloads now) */
  reset: () => void;

  /** Current offset (for debugging) */
  offset: string;

  /** SSE connection status */
  connectionStatus: ConnectionStatus;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export function usePersistentStream<TState, TEvent extends StreamEvent>({
  url,
  reducer,
  initialState,
  storageKey,
  onCaughtUp,
  suspense = true,
}: PersistentStreamConfig<TState, TEvent>): PersistentStreamResult<TState> {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [isStreaming, setIsStreaming] = useState(false);
  const [offset, setOffset] = useState("-1");
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({ state: "connecting" });
  const [isReady, setIsReady] = useState(false);

  // Refs for values that shouldn't trigger effect re-runs
  const offsetRef = useRef("-1");
  const onCaughtUpRef = useRef(onCaughtUp);

  // Keep refs in sync without triggering effects
  onCaughtUpRef.current = onCaughtUp;

  // SSE connection effect
  useEffect(() => {
    if (!url) {
      setConnectionStatus({ state: "closed" });
      setIsReady(true);
      return;
    }

    let cancelled = false;
    let eventSource: EventSource | null = null;

    setConnectionStatus({ state: "connecting" });
    offsetRef.current = "-1";
    setOffset("-1");

    const streamUrl = new URL(url, window.location.origin);
    streamUrl.searchParams.set("offset", "-1");
    streamUrl.searchParams.set("live", "sse");

    eventSource = new EventSource(streamUrl.toString());

    eventSource.onopen = () => {
      if (!cancelled) {
        setConnectionStatus({ state: "connected" });
        setIsReady(true);
        onCaughtUpRef.current?.();
      }
    };

    // Handle data events (only event type we care about)
    eventSource.addEventListener("data", (evt) => {
      if (cancelled) return;
      try {
        const data = JSON.parse((evt as MessageEvent).data);

        // Data can be a single event or an array
        const events: TEvent[] = Array.isArray(data) ? data : [data];

        for (const event of events) {
          if (!event.type) continue;

          // Update offset from event
          if (event.offset) {
            offsetRef.current = event.offset;
            setOffset(event.offset);
          }

          dispatch(event);

          // Check for streaming events (LLM token streaming)
          const payload =
            event.type === "iterate:agent:harness:pi:event-received"
              ? (event.payload as {
                  piEventType?: string;
                  piEvent?: { message?: { role?: string } };
                } | undefined)
              : null;
          const piEventType = payload?.piEventType ?? event.type;
          const messageRole = payload?.piEvent?.message?.role;

          // Only set streaming for ASSISTANT messages
          if (piEventType === "message_start" && messageRole === "assistant") {
            setIsStreaming(true);
          } else if (
            piEventType === "message_complete" ||
            piEventType === "message_end" ||
            piEventType === "agent_end" ||
            piEventType === "turn_end"
          ) {
            setIsStreaming(false);
          }
        }
      } catch (e) {
        console.error("[stream] Parse error:", e);
      }
    });

    eventSource.onerror = (err) => {
      console.error("[stream] SSE connection error:", err);
      if (!cancelled) {
        const es = eventSource;
        if (es?.readyState === EventSource.CLOSED) {
          setConnectionStatus({ state: "error", message: "Connection closed" });
        } else if (es?.readyState === EventSource.CONNECTING) {
          setConnectionStatus({ state: "connecting" });
        } else {
          setConnectionStatus({ state: "error", message: "Connection error" });
        }
      }
    };

    return () => {
      cancelled = true;
      eventSource?.close();
      setConnectionStatus({ state: "closed" });
    };
  }, [url, storageKey]);

  // Throw for Suspense if enabled and not ready
  if (suspense && url && !isReady) {
    throw new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (isReady) {
          clearInterval(interval);
          resolve();
        }
      }, 50);
    });
  }

  const reset = useCallback(() => {
    window.location.reload();
  }, []);

  return { state, isStreaming, reset, offset, connectionStatus };
}

// ─────────────────────────────────────────────────────────────────────────────
// Filters (kept for API compatibility)
// ─────────────────────────────────────────────────────────────────────────────

export function excludeChunks(event: StreamEvent): boolean {
  return event.type !== "message_updated" && event.type !== "message_chunk";
}

export function onlyTypes(...types: string[]) {
  const set = new Set(types);
  return (event: StreamEvent): boolean => set.has(event.type);
}

export function excludeTypes(...types: string[]) {
  const set = new Set(types);
  return (event: StreamEvent): boolean => !set.has(event.type);
}
