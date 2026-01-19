/**
 * Stream Reducer for Durable Streams
 *
 * A React hook that consumes a durable-streams SSE endpoint.
 * Always starts fresh from offset "-1" (no localStorage persistence).
 *
 * Compatible with any server implementing the durable-streams protocol:
 * https://github.com/durable-streams/durable-streams
 */

import { useReducer, useEffect, useRef, useState, useCallback } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface StreamEvent {
  type: string;
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
   * When true, the hook throws a promise during loading.
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
// Suspense cache
// ─────────────────────────────────────────────────────────────────────────────

type SuspenseStatus = "pending" | "resolved" | "rejected";

interface SuspenseResource<T> {
  read(): T;
}

const suspenseCache = new Map<string, SuspenseResource<void>>();

function createSuspenseResource(_key: string, promise: Promise<void>): SuspenseResource<void> {
  let status: SuspenseStatus = "pending";
  let error: unknown;

  const suspender = promise.then(
    () => {
      status = "resolved";
    },
    (e) => {
      status = "rejected";
      error = e;
    },
  );

  return {
    read() {
      if (status === "pending") throw suspender;
      if (status === "rejected") throw error;
    },
  };
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
  onMustRefetch,
  suspense = true,
}: PersistentStreamConfig<TState, TEvent>): PersistentStreamResult<TState> {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [phase, setPhase] = useState<"idle" | "connecting" | "ready">("idle");
  const [isStreaming, setIsStreaming] = useState(false);
  const [offset, setOffset] = useState("-1");
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({ state: "connecting" });

  // Refs for values that shouldn't trigger effect re-runs
  const offsetRef = useRef("-1");
  const onCaughtUpRef = useRef(onCaughtUp);
  const onMustRefetchRef = useRef(onMustRefetch);
  const readyResolverRef = useRef<(() => void) | null>(null);

  // Keep refs in sync without triggering effects
  onCaughtUpRef.current = onCaughtUp;
  onMustRefetchRef.current = onMustRefetch;

  const suspenseKey = `${storageKey}:${url}`;

  // Create suspense resource (only runs once per key)
  if (suspense && url && !suspenseCache.has(suspenseKey)) {
    const readyPromise = new Promise<void>((resolve) => {
      readyResolverRef.current = resolve;
    });
    suspenseCache.set(suspenseKey, createSuspenseResource(suspenseKey, readyPromise));
  }

  // SSE connection effect
  useEffect(() => {
    if (!url) {
      setPhase("ready");
      setConnectionStatus({ state: "closed" });
      return;
    }

    let cancelled = false;
    let eventSource: EventSource | null = null;

    setPhase("connecting");
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
      }
    };

    const handleEvent = (evt: MessageEvent, isControlEvent = false) => {
      if (cancelled) return;
      try {
        const data = JSON.parse(evt.data);

        // Extract offset from event data
        const dataOffset = Array.isArray(data) ? data[0]?.offset : data.offset;
        const newOffset = evt.lastEventId || dataOffset || data.headers?.offset;
        if (newOffset) {
          offsetRef.current = newOffset;
          setOffset(newOffset);
        }

        if (isControlEvent || data.headers?.control) {
          const controlType = isControlEvent
            ? data.upToDate
              ? "up-to-date"
              : data.streamNextOffset
                ? "offset-update"
                : null
            : data.headers.control;

          switch (controlType) {
            case "up-to-date":
              if (data.streamNextOffset) {
                offsetRef.current = data.streamNextOffset;
                setOffset(data.streamNextOffset);
              }
              setPhase("ready");
              readyResolverRef.current?.();
              onCaughtUpRef.current?.();
              break;
            case "must-refetch":
              suspenseCache.delete(suspenseKey);
              onMustRefetchRef.current?.();
              break;
            case "offset-update":
              if (data.streamNextOffset) {
                offsetRef.current = data.streamNextOffset;
                setOffset(data.streamNextOffset);
              }
              break;
          }
          if (isControlEvent) return;
          if (data.headers?.control) return;
        }

        const events: TEvent[] = Array.isArray(data) ? data : [data];

        for (const event of events) {
          if (!event.type) continue;

          dispatch(event);

          // Check for streaming events
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
    };

    eventSource.addEventListener("control", (evt) => handleEvent(evt as MessageEvent, true));
    eventSource.addEventListener("data", (evt) => handleEvent(evt as MessageEvent));

    eventSource.onerror = (err) => {
      console.error("[stream] SSE connection error:", err);
      if (!cancelled) {
        // EventSource errors don't provide detailed info, but we can check readyState
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
  }, [url, storageKey, suspenseKey]);

  // Throw for Suspense if enabled and not ready
  if (suspense && url && phase !== "ready" && phase !== "idle") {
    suspenseCache.get(suspenseKey)?.read();
  }

  const reset = useCallback(() => {
    suspenseCache.delete(suspenseKey);
    window.location.reload();
  }, [suspenseKey]);

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
