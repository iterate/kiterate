import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  usePersistentStream,
  excludeChunks,
  onlyTypes,
  excludeTypes,
} from "./durable-stream-reducer.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────

class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readyState = 1;
  private listeners: Map<string, ((event: MessageEvent) => void)[]> = new Map();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  close() {
    this.readyState = 2;
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type)!.push(listener);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void) {
    const arr = this.listeners.get(type);
    if (arr) {
      const idx = arr.indexOf(listener);
      if (idx >= 0) arr.splice(idx, 1);
    }
  }

  emit(data: unknown, lastEventId?: string) {
    const event = new MessageEvent("message", {
      data: JSON.stringify(data),
      lastEventId,
    });
    this.onmessage?.(event);
  }

  emitNamed(eventType: string, data: unknown, lastEventId?: string) {
    const event = new MessageEvent(eventType, {
      data: JSON.stringify(data),
      lastEventId,
    });
    this.listeners.get(eventType)?.forEach((l) => l(event));
  }

  emitControl(control: string) {
    this.emitNamed("control", { upToDate: control === "up-to-date" });
  }

  static reset() {
    this.instances = [];
  }
}

Object.defineProperty(globalThis, "EventSource", { value: MockEventSource });

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

interface TestState {
  items: string[];
  pending: string | null;
}

interface TestEvent {
  type: string;
  id?: string;
  content?: string;
}

const testReducer = (state: TestState, event: TestEvent): TestState => {
  switch (event.type) {
    case "item_start":
      return { ...state, pending: event.id ?? null };
    case "item_chunk":
      return { ...state, pending: (state.pending ?? "") + (event.content ?? "") };
    case "item_complete":
      return { items: [...state.items, event.content ?? ""], pending: null };
    default:
      return state;
  }
};

const initialState: TestState = { items: [], pending: null };

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("usePersistentStream", () => {
  beforeEach(() => {
    MockEventSource.reset();
    vi.clearAllMocks();
  });

  describe("connection stability (no infinite loops)", () => {
    it("creates only ONE EventSource even after up-to-date control event", async () => {
      renderHook(() =>
        usePersistentStream({
          url: "/test",
          storageKey: "stability-1",
          reducer: testReducer,
          initialState,
          suspense: false,
        }),
      );

      await waitFor(() => expect(MockEventSource.instances.length).toBe(1));

      const es = MockEventSource.instances[0];
      expect(es.readyState).toBe(1);

      act(() => {
        es.emitControl("up-to-date");
      });

      await new Promise((r) => setTimeout(r, 100));

      expect(MockEventSource.instances.length).toBe(1);
      expect(MockEventSource.instances[0]).toBe(es);
      expect(es.readyState).toBe(1);
    });

    it("does not close and reopen connection when phase changes", async () => {
      const closeSpy = vi.fn();

      renderHook(() =>
        usePersistentStream({
          url: "/test",
          storageKey: "stability-2",
          reducer: testReducer,
          initialState,
          suspense: false,
        }),
      );

      await waitFor(() => expect(MockEventSource.instances.length).toBe(1));

      const es = MockEventSource.instances[0];
      const originalClose = es.close.bind(es);
      es.close = () => {
        closeSpy();
        originalClose();
      };

      act(() => {
        es.emitControl("up-to-date");
      });

      await new Promise((r) => setTimeout(r, 100));

      expect(closeSpy).not.toHaveBeenCalled();
    });

    it("does not create multiple connections when receiving multiple events", async () => {
      renderHook(() =>
        usePersistentStream({
          url: "/test",
          storageKey: "stability-3",
          reducer: testReducer,
          initialState,
          suspense: false,
        }),
      );

      await waitFor(() => expect(MockEventSource.instances.length).toBe(1));

      const es = MockEventSource.instances[0];

      act(() => {
        es.emit({ type: "item_start", id: "1" }, "offset-1");
        es.emit({ type: "item_chunk", content: "a" }, "offset-2");
        es.emit({ type: "item_complete", content: "a" }, "offset-3");
        es.emitControl("up-to-date");
      });

      await new Promise((r) => setTimeout(r, 100));

      expect(MockEventSource.instances.length).toBe(1);
    });
  });

  describe("event processing", () => {
    it("processes events through reducer", async () => {
      const { result } = renderHook(() =>
        usePersistentStream({
          url: "/test",
          storageKey: "test-1",
          reducer: testReducer,
          initialState,
          suspense: false,
        }),
      );

      await waitFor(() => expect(MockEventSource.instances.length).toBe(1));

      act(() => {
        MockEventSource.instances[0].emitNamed("data", { type: "item_complete", content: "hello" });
      });

      await waitFor(() => {
        expect(result.current.state.items).toEqual(["hello"]);
      });
    });

    it("handles null url gracefully", () => {
      const { result } = renderHook(() =>
        usePersistentStream({
          url: null,
          storageKey: "test-null",
          reducer: testReducer,
          initialState,
          suspense: false,
        }),
      );

      expect(result.current.state).toEqual(initialState);
      expect(MockEventSource.instances.length).toBe(0);
    });
  });

  describe("offset tracking", () => {
    it("always starts from offset -1", async () => {
      renderHook(() =>
        usePersistentStream({
          url: "/test",
          storageKey: "test-5",
          reducer: testReducer,
          initialState,
          suspense: false,
        }),
      );

      await waitFor(() => expect(MockEventSource.instances.length).toBe(1));

      const url = new URL(MockEventSource.instances[0].url, "http://localhost");
      expect(url.searchParams.get("offset")).toBe("-1");
    });

    it("updates offset from SSE lastEventId", async () => {
      const { result } = renderHook(() =>
        usePersistentStream({
          url: "/test",
          storageKey: "test-6",
          reducer: testReducer,
          initialState,
          suspense: false,
        }),
      );

      await waitFor(() => expect(MockEventSource.instances.length).toBe(1));

      act(() => {
        MockEventSource.instances[0].emitNamed(
          "data",
          { type: "item_complete", content: "test" },
          "new-offset-456",
        );
      });

      await waitFor(() => {
        expect(result.current.offset).toBe("new-offset-456");
      });
    });
  });

  describe("streaming state", () => {
    it("tracks streaming from Pi assistant message_start/complete events", async () => {
      const { result } = renderHook(() =>
        usePersistentStream({
          url: "/test",
          storageKey: "test-7",
          reducer: testReducer,
          initialState,
          suspense: false,
        }),
      );

      await waitFor(() => expect(MockEventSource.instances.length).toBe(1));

      expect(result.current.isStreaming).toBe(false);

      // Use Pi-wrapped event format with role: assistant
      act(() => {
        MockEventSource.instances[0].emitNamed("data", {
          type: "iterate:agent:harness:pi:event-received",
          payload: {
            piEventType: "message_start",
            piEvent: {
              type: "message_start",
              message: { role: "assistant", content: [] },
            },
          },
        });
      });

      await waitFor(() => expect(result.current.isStreaming).toBe(true));

      act(() => {
        MockEventSource.instances[0].emitNamed("data", {
          type: "iterate:agent:harness:pi:event-received",
          payload: {
            piEventType: "message_complete",
            piEvent: { type: "message_complete" },
          },
        });
      });

      await waitFor(() => expect(result.current.isStreaming).toBe(false));
    });

    it("does NOT set streaming for user message_start events", async () => {
      const { result } = renderHook(() =>
        usePersistentStream({
          url: "/test",
          storageKey: "test-8",
          reducer: testReducer,
          initialState,
          suspense: false,
        }),
      );

      await waitFor(() => expect(MockEventSource.instances.length).toBe(1));

      expect(result.current.isStreaming).toBe(false);

      // User message_start should NOT trigger streaming
      act(() => {
        MockEventSource.instances[0].emitNamed("data", {
          type: "iterate:agent:harness:pi:event-received",
          payload: {
            piEventType: "message_start",
            piEvent: {
              type: "message_start",
              message: { role: "user", content: [] },
            },
          },
        });
      });

      // Give it a moment to process
      await new Promise((r) => setTimeout(r, 50));

      // Should still be false since it was a user message
      expect(result.current.isStreaming).toBe(false);
    });
  });
});

describe("filter helpers", () => {
  it("excludeChunks filters chunk event types", () => {
    expect(excludeChunks({ type: "message_start" })).toBe(true);
    expect(excludeChunks({ type: "message_complete" })).toBe(true);
    expect(excludeChunks({ type: "message_chunk" })).toBe(false);
    expect(excludeChunks({ type: "message_updated" })).toBe(false);
  });

  it("onlyTypes includes specified types", () => {
    const filter = onlyTypes("a", "b");
    expect(filter({ type: "a" })).toBe(true);
    expect(filter({ type: "b" })).toBe(true);
    expect(filter({ type: "c" })).toBe(false);
  });

  it("excludeTypes excludes specified types", () => {
    const filter = excludeTypes("x", "y");
    expect(filter({ type: "x" })).toBe(false);
    expect(filter({ type: "y" })).toBe(false);
    expect(filter({ type: "z" })).toBe(true);
  });
});
