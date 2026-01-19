/**
 * Durable Stream Hook
 *
 * A React hook that consumes an SSE endpoint with IndexedDB caching.
 * On page reload, only fetches events since the last cached offset (delta sync).
 */

import { useReducer, useEffect, useRef, useState, useCallback } from "react";
import {
  getCachedEvents,
  appendEvents,
  clearCache,
  type StoredEvent,
} from "@/lib/event-storage";
import type { ConnectionStatus, StreamEvent } from "@/reducers";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface DurableStreamConfig<TState, TEvent extends StreamEvent> {
  /** SSE endpoint URL. Pass null to disable. */
  url: string | null;

  /** Reducer: (state, event) => newState */
  reducer: (state: TState, event: TEvent) => TState;

  /** Initial state before any events */
  initialState: TState;

  /** Storage key for IndexedDB caching (e.g., "agent:/pi/my-session") */
  storageKey: string;

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

/** @deprecated Use DurableStreamConfig instead */
export type PersistentStreamConfig<TState, TEvent extends StreamEvent> = DurableStreamConfig<TState, TEvent> & {
  /** @deprecated Not used - filtering happens in event-storage.ts */
  shouldPersist?: (event: TEvent) => boolean;
  /** @deprecated Not used */
  replayBatchSize?: number;
};

export interface DurableStreamResult<TState> {
  /** Current reduced state */
  state: TState;

  /** True while receiving streaming events (e.g., LLM tokens) */
  isStreaming: boolean;

  /** Clear cache and reload */
  reset: () => Promise<void>;

  /** Current offset (for debugging) */
  offset: string;

  /** SSE connection status */
  connectionStatus: ConnectionStatus;
}

/** @deprecated Use DurableStreamResult instead */
export type PersistentStreamResult<TState> = DurableStreamResult<TState>;

// Re-export ConnectionStatus for convenience
export type { ConnectionStatus };

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export function useDurableStream<TState, TEvent extends StreamEvent>({
  url,
  reducer,
  initialState,
  storageKey,
  onCaughtUp,
  suspense = true,
}: DurableStreamConfig<TState, TEvent>): DurableStreamResult<TState> {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [isStreaming, setIsStreaming] = useState(false);
  const [offset, setOffset] = useState("-1");
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({ state: "connecting" });
  const [isReady, setIsReady] = useState(false);
  const [cacheLoaded, setCacheLoaded] = useState(false);

  // Refs for values that shouldn't trigger effect re-runs
  const offsetRef = useRef("-1");
  const onCaughtUpRef = useRef(onCaughtUp);

  // Keep refs in sync without triggering effects
  onCaughtUpRef.current = onCaughtUp;

  // Load cached events on mount
  useEffect(() => {
    if (!storageKey) {
      setCacheLoaded(true);
      return;
    }

    let cancelled = false;

    async function loadCache() {
      try {
        const cached = await getCachedEvents(storageKey);
        if (cancelled) return;

        if (cached && cached.events.length > 0) {
          console.log(`[durable-stream] Loaded ${cached.events.length} cached events, lastOffset: ${cached.lastOffset}`);
          
          // Replay cached events through reducer
          for (const event of cached.events) {
            dispatch(event as TEvent);
          }

          // Set offset to continue from where we left off
          offsetRef.current = cached.lastOffset;
          setOffset(cached.lastOffset);
        }
      } catch (error) {
        console.warn("[durable-stream] Failed to load cache:", error);
      } finally {
        if (!cancelled) {
          setCacheLoaded(true);
        }
      }
    }

    loadCache();

    return () => {
      cancelled = true;
    };
  }, [storageKey]);

  // SSE connection effect - waits for cache to load first
  useEffect(() => {
    if (!url || !cacheLoaded) {
      if (!url) {
        setConnectionStatus({ state: "closed" });
        setIsReady(true);
      }
      return;
    }

    let cancelled = false;
    let eventSource: EventSource | null = null;

    setConnectionStatus({ state: "connecting" });

    // Use cached offset or start from beginning
    const startOffset = offsetRef.current;
    console.log(`[durable-stream] Connecting with offset: ${startOffset}`);

    const streamUrl = new URL(url, window.location.origin);
    streamUrl.searchParams.set("offset", startOffset);
    streamUrl.searchParams.set("live", "sse");

    eventSource = new EventSource(streamUrl.toString());

    eventSource.onopen = () => {
      if (!cancelled) {
        setConnectionStatus({ state: "connected" });
        setIsReady(true);
        onCaughtUpRef.current?.();
      }
    };

    // Handle data events
    eventSource.addEventListener("data", (evt) => {
      if (cancelled) return;
      try {
        const data = JSON.parse((evt as MessageEvent).data);

        // Data can be a single event or an array
        const events: TEvent[] = Array.isArray(data) ? data : [data];
        const eventsToCache: StoredEvent[] = [];

        for (const event of events) {
          if (!event.type) continue;

          // Update offset from event
          if (event.offset) {
            offsetRef.current = event.offset;
            setOffset(event.offset);
          }

          // Dispatch to reducer
          dispatch(event);

          // Collect for caching (filtering happens in event-storage.ts)
          eventsToCache.push(event as StoredEvent);

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

        // Batch cache new events (filtering happens inside appendEvents)
        if (eventsToCache.length > 0 && storageKey) {
          appendEvents(storageKey, eventsToCache, offsetRef.current).catch((err) => {
            console.warn("[durable-stream] Failed to cache events:", err);
          });
        }
      } catch (e) {
        console.error("[durable-stream] Parse error:", e);
      }
    });

    eventSource.onerror = (err) => {
      console.error("[durable-stream] SSE connection error:", err);
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
  }, [url, storageKey, cacheLoaded]);

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

  const reset = useCallback(async () => {
    if (storageKey) {
      await clearCache(storageKey);
    }
    window.location.reload();
  }, [storageKey]);

  return { state, isStreaming, reset, offset, connectionStatus };
}

/** @deprecated Use useDurableStream instead */
export function usePersistentStream<TState, TEvent extends StreamEvent>(
  config: PersistentStreamConfig<TState, TEvent>
): PersistentStreamResult<TState> {
  // Ignore deprecated fields (shouldPersist, replayBatchSize)
  // Filtering now happens in event-storage.ts
  return useDurableStream(config);
}
