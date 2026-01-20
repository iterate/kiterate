import { describe, it, expect } from "vitest";
import {
  createInitialOpenCodeState,
  getMessages as getOpenCodeMessages,
  openCodeReducer,
} from "./opencode";
import { createInitialWrapperState, getWrapperMessages, wrapperReducer } from "./index";

const OPENCODE_EVENT = "iterate:agent:harness:opencode:event-received";

describe("openCodeReducer (inner)", () => {
  it("should stream assistant parts into a single message item", () => {
    let state = createInitialOpenCodeState();

    state = openCodeReducer(state, {
      type: "message.updated",
      properties: { info: { id: "msg_user", role: "user" } },
    });
    state = openCodeReducer(state, {
      type: "message.part.updated",
      properties: { part: { messageID: "msg_user", type: "text", text: "hi" } },
    });

    expect(getOpenCodeMessages(state)).toHaveLength(0);
    expect(state.isStreaming).toBe(false);

    state = openCodeReducer(state, {
      type: "message.updated",
      properties: { info: { id: "msg_assistant", role: "assistant" } },
    });
    state = openCodeReducer(state, {
      type: "message.part.updated",
      properties: { part: { messageID: "msg_assistant", type: "text", text: "Hello" } },
    });
    state = openCodeReducer(state, {
      type: "message.part.updated",
      properties: {
        part: { messageID: "msg_assistant", type: "text", text: "Hello! How" },
      },
    });

    expect(getOpenCodeMessages(state)).toHaveLength(1);
    expect(state.isStreaming).toBe(true);
    expect(getOpenCodeMessages(state)[0].content[0].text).toBe("Hello! How");

    state = openCodeReducer(state, {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_assistant",
          role: "assistant",
          parts: [{ type: "text", text: "Hello! How" }],
        },
      },
    });

    expect(getOpenCodeMessages(state)).toHaveLength(1);
    expect(getOpenCodeMessages(state)[0].content[0].text).toBe("Hello! How");
    expect(state.isStreaming).toBe(false);
  });

  it("should clear streaming on session.updated", () => {
    let state = createInitialOpenCodeState();
    state = openCodeReducer(state, {
      type: "message.updated",
      properties: { info: { id: "msg_assistant", role: "assistant" } },
    });
    state = openCodeReducer(state, {
      type: "message.part.updated",
      properties: { part: { messageID: "msg_assistant", type: "text", text: "Hi" } },
    });
    expect(state.isStreaming).toBe(true);

    state = openCodeReducer(state, { type: "session.updated", properties: { info: {} } });
    expect(state.isStreaming).toBe(false);
  });

  it("should map tool parts into tool feed items", () => {
    let state = createInitialOpenCodeState();
    state = openCodeReducer(state, {
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          callID: "tc1",
          tool: "bash",
          state: {
            status: "pending",
            input: { command: "ls -la" },
          },
        },
      },
    });

    const tools = state.feed.filter((item) => item.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0].state).toBe("pending");

    state = openCodeReducer(state, {
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          callID: "tc1",
          tool: "bash",
          state: {
            status: "completed",
            output: "ok",
          },
        },
      },
    });

    const updatedTools = state.feed.filter((item) => item.kind === "tool");
    expect(updatedTools).toHaveLength(1);
    expect(updatedTools[0].state).toBe("completed");
  });
});

describe("wrapperReducer (OpenCode envelopes)", () => {
  it("should keep roles across events and avoid user chunks", () => {
    const events = [
      {
        type: OPENCODE_EVENT,
        payload: {
          openCodeEvent: {
            type: "message.updated",
            properties: { info: { id: "msg_user", role: "user" } },
          },
        },
      },
      {
        type: OPENCODE_EVENT,
        payload: {
          openCodeEvent: {
            type: "message.part.updated",
            properties: { part: { messageID: "msg_user", type: "text", text: "hi" } },
          },
        },
      },
      {
        type: OPENCODE_EVENT,
        payload: {
          openCodeEvent: {
            type: "message.updated",
            properties: { info: { id: "msg_assistant", role: "assistant" } },
          },
        },
      },
      {
        type: OPENCODE_EVENT,
        payload: {
          openCodeEvent: {
            type: "message.part.updated",
            properties: {
              part: { messageID: "msg_assistant", type: "text", text: "Hello" },
            },
          },
        },
      },
    ];

    let state = createInitialWrapperState();
    for (const event of events) {
      state = wrapperReducer(state, event);
    }

    expect(getWrapperMessages(state)).toHaveLength(1);
    expect(state.isStreaming).toBe(true);
    expect(getWrapperMessages(state)[0].content[0].text).toBe("Hello");
  });
});
