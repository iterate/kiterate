import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import YAML from "yaml";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { piReducer, createInitialPiState, getMessages } from "./pi";
import {
  wrapperReducer,
  createInitialWrapperState,
  getWrapperMessages,
  getWrapperTools,
  type WrapperState,
} from "./index";

/**
 * Parse a YAML stream file and extract the inner piEvent from each message.
 */
function parseYamlStreamPiEvents(yamlString: string): AgentSessionEvent[] {
  const data = YAML.parse(yamlString);
  if (!data?.messages || !Array.isArray(data.messages)) {
    return [];
  }
  return data.messages
    .map((m: Record<string, unknown>) => {
      const content = m.content as { payload?: { piEvent?: unknown } } | undefined;
      return content?.payload?.piEvent as AgentSessionEvent | undefined;
    })
    .filter((e: AgentSessionEvent | undefined): e is AgentSessionEvent => e !== undefined);
}

/**
 * Parse a YAML stream file and extract the full envelope events.
 */
function parseYamlStreamEnvelopes(yamlString: string): unknown[] {
  const data = YAML.parse(yamlString);
  if (!data?.messages || !Array.isArray(data.messages)) {
    return [];
  }
  return data.messages.map((m: Record<string, unknown>) => m.content);
}

/**
 * Reduce PI events using the inner reducer.
 */
function reducePiEvents(events: AgentSessionEvent[]) {
  return events.reduce(piReducer, createInitialPiState());
}

/**
 * Reduce envelope events using the wrapper reducer.
 */
function reduceWrapperEvents(events: unknown[]): WrapperState {
  return events.reduce(wrapperReducer, createInitialWrapperState());
}

// ─────────────────────────────────────────────────────────────────────────────
// Test data: Minimal conversation
// ─────────────────────────────────────────────────────────────────────────────

const SINGLE_TURN_YAML = `
id: test
contentType: application/json
createdAt: 2026-01-05T20:00:00.000Z
messages:
  - offset: "1"
    content:
      type: iterate:agent:harness:pi:event-received
      createdAt: 2026-01-05T20:00:01.001Z
      payload:
        piEventType: agent_start
        piEvent:
          type: agent_start
    timestamp: 2026-01-05T20:00:01.001Z
  - offset: "2"
    content:
      type: iterate:agent:harness:pi:event-received
      createdAt: 2026-01-05T20:00:01.002Z
      payload:
        piEventType: message_end
        piEvent:
          type: message_end
          message:
            role: user
            content:
              - type: text
                text: hello
            timestamp: 1234567890
    timestamp: 2026-01-05T20:00:01.002Z
  - offset: "3"
    content:
      type: iterate:agent:harness:pi:event-received
      createdAt: 2026-01-05T20:00:01.003Z
      payload:
        piEventType: message_start
        piEvent:
          type: message_start
          message:
            role: assistant
            content: []
            timestamp: 1234567891
    timestamp: 2026-01-05T20:00:01.003Z
  - offset: "4"
    content:
      type: iterate:agent:harness:pi:event-received
      createdAt: 2026-01-05T20:00:01.004Z
      payload:
        piEventType: message_end
        piEvent:
          type: message_end
          message:
            role: assistant
            content:
              - type: text
                text: "Hi there!"
            timestamp: 1234567891
    timestamp: 2026-01-05T20:00:01.004Z
  - offset: "5"
    content:
      type: iterate:agent:harness:pi:event-received
      createdAt: 2026-01-05T20:00:01.005Z
      payload:
        piEventType: agent_end
        piEvent:
          type: agent_end
          messages: []
    timestamp: 2026-01-05T20:00:01.005Z
`;

const TOOL_CALL_YAML = `
id: test-tools
contentType: application/json
createdAt: 2026-01-05T20:00:00.000Z
messages:
  - offset: "1"
    content:
      type: iterate:agent:harness:pi:event-received
      createdAt: 2026-01-05T20:00:01.001Z
      payload:
        piEventType: tool_execution_start
        piEvent:
          type: tool_execution_start
          toolCallId: call_123
          toolName: read
          args:
            path: /tmp/demo.txt
    timestamp: 2026-01-05T20:00:01.001Z
  - offset: "2"
    content:
      type: iterate:agent:harness:pi:event-received
      createdAt: 2026-01-05T20:00:01.002Z
      payload:
        piEventType: tool_execution_end
        piEvent:
          type: tool_execution_end
          toolCallId: call_123
          toolName: read
          result: ""
          isError: false
    timestamp: 2026-01-05T20:00:01.002Z
`;

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Inner PI Reducer (typed AgentSessionEvent)
// ─────────────────────────────────────────────────────────────────────────────

describe("piReducer (inner, typed)", () => {
  it("should reduce PI events to messages (ignores user messages)", () => {
    // piReducer ignores user messages - they're handled by send-user-message:called
    // So we only get the assistant message from the test data
    const events = parseYamlStreamPiEvents(SINGLE_TURN_YAML);
    const state = reducePiEvents(events);

    expect(getMessages(state)).toHaveLength(1);
    expect(getMessages(state)[0].role).toBe("assistant");
    expect(state.isStreaming).toBe(false);
  });

  it("should handle message_start for assistant", () => {
    let state = createInitialPiState();
    const event: AgentSessionEvent = {
      type: "message_start",
      message: { role: "assistant", content: [], timestamp: 123 } as any,
    };
    state = piReducer(state, event);

    expect(state.isStreaming).toBe(true);
    expect(state.streamingMessage?.role).toBe("assistant");
  });

  it("should ignore message_end for user (handled by send-user-message:called)", () => {
    // User messages are handled by send-user-message:called in wrapperReducer,
    // so PI SDK's message_end for user should be ignored to avoid duplicates.
    let state = createInitialPiState();
    const event: AgentSessionEvent = {
      type: "message_end",
      message: {
        role: "user",
        content: [{ type: "text", text: "hello" }],
        timestamp: 123,
      } as any,
    };
    state = piReducer(state, event);

    expect(getMessages(state)).toHaveLength(0);
  });

  it("should handle message_end for assistant", () => {
    let state = createInitialPiState();
    state = piReducer(state, {
      type: "message_start",
      message: { role: "assistant", content: [], timestamp: 123 } as any,
    });
    state = piReducer(state, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hi!" }],
        timestamp: 123,
      } as any,
    });

    expect(state.isStreaming).toBe(false);
    expect(getMessages(state)).toHaveLength(1);
  });

  it("should handle tool execution lifecycle", () => {
    let state = createInitialPiState();

    state = piReducer(state, {
      type: "tool_execution_start",
      toolCallId: "tc1",
      toolName: "read",
      args: { path: "/test" },
    });
    expect(state.feed).toHaveLength(1);
    expect(state.feed[0].kind).toBe("tool");

    state = piReducer(state, {
      type: "tool_execution_end",
      toolCallId: "tc1",
      toolName: "read",
      result: "content",
      isError: false,
    });
    expect((state.feed[0] as any).state).toBe("completed");
  });

  it("should complete tool even if activeTools is out of sync", () => {
    const state = {
      ...createInitialPiState(),
      feed: [
        {
          kind: "tool",
          toolCallId: "tc2",
          toolName: "read",
          state: "pending",
          input: { path: "/tmp/demo.txt" },
          startTimestamp: Date.now(),
        },
      ],
    };

    const next = piReducer(state, {
      type: "tool_execution_end",
      toolCallId: "tc2",
      toolName: "read",
      result: "done",
      isError: false,
    });

    expect((next.feed[0] as any).state).toBe("completed");
  });

  it("should clear streaming on agent_end", () => {
    let state = createInitialPiState();
    state = piReducer(state, {
      type: "message_start",
      message: { role: "assistant", content: [] } as any,
    });
    expect(state.isStreaming).toBe(true);

    state = piReducer(state, { type: "agent_end", messages: [] });
    expect(state.isStreaming).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Wrapper Reducer (envelope extraction)
// ─────────────────────────────────────────────────────────────────────────────

describe("wrapperReducer (envelope extraction)", () => {
  it("should extract PI events from envelopes (ignores PI user messages)", () => {
    // The SINGLE_TURN_YAML doesn't have send-user-message:called events,
    // so user messages from PI SDK are ignored. Only assistant message is kept.
    const events = parseYamlStreamEnvelopes(SINGLE_TURN_YAML);
    const state = reduceWrapperEvents(events);

    expect(getWrapperMessages(state)).toHaveLength(1);
    expect(getWrapperMessages(state)[0].role).toBe("assistant");
    expect(state.rawEvents).toHaveLength(events.length);
  });

  it("should handle user message action events", () => {
    // User message actions create both EventFeedItem (for raw display) and MessageFeedItem.
    // PI SDK's message_end for user is ignored to avoid duplicates.
    let state = createInitialWrapperState();
    state = wrapperReducer(state, {
      type: "iterate:agent:action:send-user-message:called",
      payload: { content: "hello from action" },
    });

    // Should have EventFeedItem and MessageFeedItem
    expect(state.feed).toHaveLength(2);
    expect(state.feed[0].kind).toBe("event");
    expect(state.feed[1].kind).toBe("message");
    expect(getWrapperMessages(state)).toHaveLength(1);
    expect(getWrapperMessages(state)[0].content[0].text).toBe("hello from action");
  });

  it("should handle generic agent errors", () => {
    let state = createInitialWrapperState();
    state = wrapperReducer(state, {
      type: "iterate:agent:error",
      createdAt: "2026-01-05T20:00:00.000Z",
      payload: {
        message: "Authentication failed",
        context: "session-create",
      },
    });

    // Should have both EventFeedItem (for raw display) and ErrorFeedItem
    expect(state.feed).toHaveLength(2);
    expect(state.feed[0].kind).toBe("event");
    expect(state.feed[1].kind).toBe("error");
    expect((state.feed[1] as any).message).toBe("Authentication failed");
  });

  it("should create event items for unknown events", () => {
    let state = createInitialWrapperState();
    state = wrapperReducer(state, {
      type: "some:unknown:event",
      data: "test",
    });

    expect(state.feed).toHaveLength(1);
    expect(state.feed[0].kind).toBe("event");
    expect((state.feed[0] as any).eventType).toBe("some:unknown:event");
  });

  it("should track all raw events", () => {
    const events = parseYamlStreamEnvelopes(SINGLE_TURN_YAML);
    const state = reduceWrapperEvents(events);

    expect(state.rawEvents).toHaveLength(events.length);
  });

  it("should mark tool calls completed from PI envelope events", () => {
    const events = parseYamlStreamEnvelopes(TOOL_CALL_YAML);
    const state = reduceWrapperEvents(events);

    const tools = getWrapperTools(state);
    expect(tools).toHaveLength(1);
    expect(tools[0].state).toBe("completed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Real YAML data
// ─────────────────────────────────────────────────────────────────────────────

describe("real YAML data", () => {
  const loadHiYaml = () => {
    const yamlPath = join(__dirname, "../../.iterate/hi.yaml");
    try {
      return readFileSync(yamlPath, "utf-8");
    } catch {
      return null;
    }
  };

  it("should handle real conversation data", () => {
    const yamlContent = loadHiYaml();
    if (!yamlContent) {
      console.log("Skipping: hi.yaml not found");
      return;
    }

    const events = parseYamlStreamEnvelopes(yamlContent);
    const state = reduceWrapperEvents(events);

    expect(getWrapperMessages(state).length).toBeGreaterThanOrEqual(2);
    expect(state.isStreaming).toBe(false);
  });
});
