import { describe, expect, it } from "vitest";
import { iterateReducer, createInitialIterateState, getMessages } from "./iterate";

describe("iterateReducer", () => {
  it("accumulates text-delta events into a streaming message", () => {
    let state = createInitialIterateState();

    // response-metadata starts the response
    state = iterateReducer(state, {
      type: "iterate:llm-loop:response:sse",
      payload: {
        part: {
          type: "response-metadata",
          modelId: { _tag: "Some", value: "gpt-4o-2024-08-06" },
        },
      },
      createdAt: "2026-01-20T15:38:41.642Z",
    });
    expect(state.isStreaming).toBe(true);

    // text-start begins a text message
    state = iterateReducer(state, {
      type: "iterate:llm-loop:response:sse",
      payload: {
        part: {
          type: "text-start",
          id: "msg_123",
        },
      },
      createdAt: "2026-01-20T15:38:42.622Z",
    });
    expect(state.streamingMessageId).toBe("msg_123");
    expect(state.streamingText).toBe("");

    // text-delta adds text chunks
    state = iterateReducer(state, {
      type: "iterate:llm-loop:response:sse",
      payload: {
        part: {
          type: "text-delta",
          id: "msg_123",
          delta: "Hello",
        },
      },
      createdAt: "2026-01-20T15:38:42.632Z",
    });
    expect(state.streamingText).toBe("Hello");

    state = iterateReducer(state, {
      type: "iterate:llm-loop:response:sse",
      payload: {
        part: {
          type: "text-delta",
          id: "msg_123",
          delta: "!",
        },
      },
      createdAt: "2026-01-20T15:38:42.636Z",
    });
    expect(state.streamingText).toBe("Hello!");

    state = iterateReducer(state, {
      type: "iterate:llm-loop:response:sse",
      payload: {
        part: {
          type: "text-delta",
          id: "msg_123",
          delta: " How can I assist you today?",
        },
      },
      createdAt: "2026-01-20T15:38:42.638Z",
    });
    expect(state.streamingText).toBe("Hello! How can I assist you today?");

    // text-end finalizes the message
    state = iterateReducer(state, {
      type: "iterate:llm-loop:response:sse",
      payload: {
        part: {
          type: "text-end",
          id: "msg_123",
        },
      },
      createdAt: "2026-01-20T15:38:42.781Z",
    });

    const messages = getMessages(state);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].content).toEqual([
      { type: "text", text: "Hello! How can I assist you today?" },
    ]);
    expect(state.isStreaming).toBe(false);
    expect(state.streamingText).toBe("");
  });

  it("handles finish event that finalizes remaining text", () => {
    let state = createInitialIterateState();

    state = iterateReducer(state, {
      type: "iterate:llm-loop:response:sse",
      payload: { part: { type: "text-start", id: "msg_456" } },
      createdAt: "2026-01-20T15:38:42.622Z",
    });

    state = iterateReducer(state, {
      type: "iterate:llm-loop:response:sse",
      payload: { part: { type: "text-delta", id: "msg_456", delta: "Partial text" } },
      createdAt: "2026-01-20T15:38:42.632Z",
    });

    // finish without text-end should still finalize
    state = iterateReducer(state, {
      type: "iterate:llm-loop:response:sse",
      payload: {
        part: {
          type: "finish",
          reason: "stop",
          usage: { inputTokens: 9, outputTokens: 10, totalTokens: 19 },
        },
      },
      createdAt: "2026-01-20T15:38:42.914Z",
    });

    const messages = getMessages(state);
    expect(messages).toHaveLength(1);
    expect(messages[0].content[0].text).toBe("Partial text");
    expect(state.isStreaming).toBe(false);
  });

  it("updates message in-place when same message ID has more deltas", () => {
    let state = createInitialIterateState();

    // Start message
    state = iterateReducer(state, {
      type: "iterate:llm-loop:response:sse",
      payload: { part: { type: "text-start", id: "msg_789" } },
      createdAt: "2026-01-20T15:38:42.622Z",
    });

    // First delta - adds message to feed
    state = iterateReducer(state, {
      type: "iterate:llm-loop:response:sse",
      payload: { part: { type: "text-delta", id: "msg_789", delta: "First" } },
      createdAt: "2026-01-20T15:38:42.632Z",
    });
    expect(state.feed).toHaveLength(1);

    // Second delta - should update in place
    state = iterateReducer(state, {
      type: "iterate:llm-loop:response:sse",
      payload: { part: { type: "text-delta", id: "msg_789", delta: " Second" } },
      createdAt: "2026-01-20T15:38:42.640Z",
    });
    expect(state.feed).toHaveLength(1);
    expect((state.feed[0] as { content: Array<{ text: string }> }).content[0].text).toBe(
      "First Second",
    );
  });
});
