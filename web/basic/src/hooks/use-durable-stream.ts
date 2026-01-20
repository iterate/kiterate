/**
 * Durable Stream Hook
 *
 * A React hook that consumes an SSE endpoint with IndexedDB caching.
 * On page reload, only fetches events since the last cached offset (delta sync).
 */

import { useReducer, useEffect, useRef, useState, useCallback } from "react";
import { getCachedEvents, appendEvents, clearCache, type StoredEvent } from "@/lib/event-storage";
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
   * Called for events that arrive during the live phase (not from cache or catchup).
   * Useful for triggering side effects (like audio playback) only for new events.
   */
  onLiveEvent?: (event: TEvent, state: TState) => void;

  /**
   * Whether to use Suspense integration.
   * @default true
   */
  suspense?: boolean;
}

/** @deprecated Use DurableStreamConfig instead */
export type PersistentStreamConfig<TState, TEvent extends StreamEvent> = DurableStreamConfig<
  TState,
  TEvent
> & {
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
  onLiveEvent,
  suspense = true,
}: DurableStreamConfig<TState, TEvent>): DurableStreamResult<TState> {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [isStreaming, setIsStreaming] = useState(false);
  const [offset, setOffset] = useState("-1");
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({
    state: "connecting",
  });
  const [isReady, setIsReady] = useState(false);
  const [cacheLoaded, setCacheLoaded] = useState(false);

  // Refs for values that shouldn't trigger effect re-runs
  const offsetRef = useRef("-1");
  const onCaughtUpRef = useRef(onCaughtUp);
  const onLiveEventRef = useRef(onLiveEvent);
  const stateRef = useRef(state);

  // Keep refs in sync without triggering effects
  onCaughtUpRef.current = onCaughtUp;
  onLiveEventRef.current = onLiveEvent;
  stateRef.current = state;

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
          console.log(
            `[durable-stream] Loaded ${cached.events.length} cached events, lastOffset: ${cached.lastOffset}`,
          );

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

  // Two-phase connection: catchup first (non-live), then live
  // With automatic reconnection on failure
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
    let isLive = false; // Track when we're truly live
    let reconnectAttempt = 0;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

    const MAX_RECONNECT_DELAY = 30000; // 30 seconds max
    const BASE_DELAY = 1000; // 1 second base

    const getReconnectDelay = () => {
      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (capped)
      const delay = Math.min(BASE_DELAY * Math.pow(2, reconnectAttempt), MAX_RECONNECT_DELAY);
      return delay + Math.random() * 1000; // Add jitter
    };

    // Helper to process events
    const processEvents = (events: TEvent[], isLivePhase: boolean) => {
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

        // Call onLiveEvent only for live phase events
        if (isLivePhase) {
          onLiveEventRef.current?.(event, stateRef.current);
        }

        // Collect for caching
        eventsToCache.push(event as StoredEvent);

        // Check for streaming events
        const payload =
          event.type === "iterate:agent:harness:pi:event-received"
            ? (event.payload as
                | {
                    piEventType?: string;
                    piEvent?: { message?: { role?: string } };
                  }
                | undefined)
            : null;
        const piEventType = payload?.piEventType ?? event.type;
        const messageRole = payload?.piEvent?.message?.role;

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

      // Cache events
      if (eventsToCache.length > 0 && storageKey) {
        appendEvents(storageKey, eventsToCache, offsetRef.current).catch((err) => {
          console.warn("[durable-stream] Failed to cache events:", err);
        });
      }
    };

    // Schedule a reconnection attempt
    const scheduleReconnect = () => {
      if (cancelled || reconnectTimeout) return;

      const delay = getReconnectDelay();
      console.log(
        `[durable-stream] Scheduling reconnect in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempt + 1})`,
      );
      setConnectionStatus({ state: "connecting" });

      reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null;
        if (!cancelled) {
          reconnectAttempt++;
          connect();
        }
      }, delay);
    };

    // Main connection function (can be called for initial connect and reconnects)
    const connect = () => {
      if (cancelled) return;

      // Close any existing connection
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      isLive = false;

      setConnectionStatus({ state: "connecting" });

      const startOffset = offsetRef.current;

      // Phase 1: Catchup (non-live) - fetch history only
      const catchupUrl = new URL(url, window.location.origin);
      catchupUrl.searchParams.set("offset", startOffset);
      // No live param = history only

      console.log(`[durable-stream] Phase 1: Catchup from offset ${startOffset}`);

      fetch(catchupUrl.toString())
        .then(async (res) => {
          if (cancelled) return;
          if (!res.ok) throw new Error(`Catchup failed: ${res.status}`);

          // Reset reconnect counter on successful catchup
          reconnectAttempt = 0;

          // Parse SSE response (server returns SSE format even for non-live)
          const text = await res.text();
          const events: TEvent[] = [];
          // SSE format: "event: data\ndata: {...json...}\n\n"
          for (const block of text.split("\n\n")) {
            const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
            if (dataLine) {
              const json = dataLine.slice(6); // Remove "data: " prefix
              events.push(JSON.parse(json));
            }
          }

          if (events.length > 0) {
            console.log(`[durable-stream] Catchup: ${events.length} events`);
            processEvents(events, false); // Not live
          }

          if (cancelled) return;

          // Phase 2: Live connection
          const liveOffset = offsetRef.current;
          console.log(`[durable-stream] Phase 2: Live from offset ${liveOffset}`);

          const liveUrl = new URL(url, window.location.origin);
          liveUrl.searchParams.set("offset", liveOffset);
          liveUrl.searchParams.set("live", "sse");

          eventSource = new EventSource(liveUrl.toString());
          isLive = true;

          eventSource.onopen = () => {
            if (!cancelled) {
              reconnectAttempt = 0; // Reset on successful connection
              setConnectionStatus({ state: "connected" });
              setIsReady(true);
              onCaughtUpRef.current?.();
            }
          };

          eventSource.addEventListener("data", (evt) => {
            if (cancelled) return;
            try {
              const data = JSON.parse((evt as MessageEvent).data);
              const events: TEvent[] = Array.isArray(data) ? data : [data];
              processEvents(events, isLive);
            } catch (e) {
              console.error("[durable-stream] Parse error:", e);
            }
          });

          eventSource.onerror = () => {
            if (cancelled) return;

            const es = eventSource;
            if (es?.readyState === EventSource.CLOSED) {
              // Connection was closed - attempt reconnect
              console.log("[durable-stream] SSE connection closed, will reconnect");
              eventSource?.close();
              eventSource = null;
              isLive = false;
              scheduleReconnect();
            } else if (es?.readyState === EventSource.CONNECTING) {
              // Browser is auto-reconnecting
              setConnectionStatus({ state: "connecting" });
            } else {
              // Other error - close and reconnect manually
              console.log("[durable-stream] SSE error, will reconnect");
              eventSource?.close();
              eventSource = null;
              isLive = false;
              scheduleReconnect();
            }
          };
        })
        .catch((err) => {
          if (cancelled) return;
          console.error("[durable-stream] Catchup error:", err);
          setConnectionStatus({ state: "error", message: err.message });
          setIsReady(true); // Allow UI to render even on error
          scheduleReconnect(); // Try to reconnect
        });
    };

    // Start initial connection
    connect();

    return () => {
      cancelled = true;
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
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
  config: PersistentStreamConfig<TState, TEvent>,
): PersistentStreamResult<TState> {
  // Ignore deprecated fields (shouldPersist, replayBatchSize)
  // Filtering now happens in event-storage.ts
  return useDurableStream(config);
}
