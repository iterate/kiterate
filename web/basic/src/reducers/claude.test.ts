import { describe, expect, it } from "vitest";
import { claudeReducer, createInitialClaudeState, getTools } from "./claude";

describe("claudeReducer", () => {
  it("completes tool when tool_result arrives on user event", () => {
    let state = createInitialClaudeState();

    state = claudeReducer(state, {
      type: "assistant",
      session_id: "s1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Bash",
            input: { command: "ls -la" },
          },
        ],
      },
    });

    state = claudeReducer(state, {
      type: "user",
      session_id: "s1",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "ok",
          },
        ],
      },
    });

    const tools = getTools(state);
    expect(tools).toHaveLength(1);
    expect(tools[0].state).toBe("completed");
  });
});
