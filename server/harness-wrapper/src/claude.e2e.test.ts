/**
 * E2E test for Claude Agent
 *
 * Tests that:
 * - Multiple concurrent SSE subscribers receive the same events
 * - Claude agent can process a simple math question
 * - Returns the correct answer with expected events
 *
 * Requirements:
 * - Claude Code CLI must be installed and in PATH
 */
import { ChildProcess, spawn, execSync } from "node:child_process";
import { describe, it, expect, afterAll, beforeAll } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const SERVER_PORT = process.env.TEST_PORT ?? "3099";
const SERVER_HOST = "127.0.0.1";
const SERVER_URL = `http://${SERVER_HOST}:${SERVER_PORT}`;

// Check if Claude Code CLI is available
function isClaudeCodeAvailable(): boolean {
  try {
    execSync("which claude", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const CLAUDE_CODE_AVAILABLE = isClaudeCodeAvailable();

// Use unique agent path per test run to avoid conflicts
const TEST_RUN_ID = Date.now();

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface SSEEvent {
  type?: string;
  offset?: string;
  payload?: {
    claudeEventType?: string;
    claudeSessionId?: string;
    claudeEvent?: {
      type: string;
      message?: {
        content?: Array<{ type: string; text?: string }>;
      };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Server Management
// ─────────────────────────────────────────────────────────────────────────────

let serverProcess: ChildProcess | null = null;
let useExternalServer = false;

async function isServerRunning(): Promise<boolean> {
  try {
    const response = await fetch(`${SERVER_URL}/`);
    return response.ok;
  } catch {
    return false;
  }
}

async function startServer(): Promise<void> {
  // Check if server is already running (e.g., in dev mode)
  if (await isServerRunning()) {
    console.log(`[Test] Using existing server at ${SERVER_URL}`);
    useExternalServer = true;
    return;
  }

  console.log(`[Test] Starting server on port ${SERVER_PORT}...`);

  serverProcess = spawn("npx", ["tsx", "src/index.ts"], {
    env: {
      ...process.env,
      PORT: SERVER_PORT,
      HOST: SERVER_HOST,
    },
    stdio: ["ignore", "pipe", "pipe"],
    cwd: new URL("..", import.meta.url).pathname,
  });

  // Log server output for debugging
  serverProcess.stdout?.on("data", (data) => {
    console.log(`[Server] ${data.toString().trim()}`);
  });

  serverProcess.stderr?.on("data", (data) => {
    console.error(`[Server Error] ${data.toString().trim()}`);
  });

  // Wait for server to be ready
  const maxWaitMs = 30_000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    if (await isServerRunning()) {
      console.log(`[Test] Server ready after ${Date.now() - startTime}ms`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Server failed to start within ${maxWaitMs}ms`);
}

function stopServer(): void {
  if (serverProcess && !useExternalServer) {
    console.log("[Test] Stopping server...");
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function* subscribeToSSE(path: string, signal: AbortSignal): AsyncGenerator<SSEEvent> {
  const url = `${SERVER_URL}/agents${path}?live=sse`;
  console.log(`[Test] Subscribing to SSE: ${url}`);

  const response = await fetch(url, {
    headers: { Accept: "text/event-stream" },
    signal,
  });

  if (!response.ok) {
    throw new Error(`SSE subscription failed: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events from buffer
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.startsWith("data:")) {
          const jsonStr = line.slice(5).trim();
          if (jsonStr) {
            try {
              const event = JSON.parse(jsonStr) as SSEEvent;
              yield event;
            } catch (_err) {
              console.error(`[Test] Failed to parse SSE event: ${jsonStr}`);
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function postUserMessage(path: string, content: string): Promise<void> {
  const url = `${SERVER_URL}/agents${path}`;
  console.log(`[Test] Posting message to ${url}: "${content}"`);

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "iterate:agent:action:send-user-message:called",
      version: 1,
      payload: { content },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`POST failed: ${response.status} - ${text}`);
  }

  const result = await response.json();
  console.log(`[Test] Message posted, offset: ${result.offset}`);
}

/**
 * Fetch all events from a path (one-shot, no live subscription).
 * The server closes the connection after sending all existing events.
 */
async function fetchAllEvents(path: string, offset = "-1"): Promise<SSEEvent[]> {
  const url = `${SERVER_URL}/agents${path}?offset=${offset}`;
  console.log(`[Test] Fetching events from: ${url}`);

  const response = await fetch(url, {
    headers: { Accept: "text/event-stream" },
  });

  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status}`);
  }

  const events: SSEEvent[] = [];
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events from buffer
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("data:")) {
          const jsonStr = line.slice(5).trim();
          if (jsonStr) {
            try {
              const event = JSON.parse(jsonStr) as SSEEvent;
              events.push(event);
            } catch (_err) {
              console.error(`[Test] Failed to parse SSE event: ${jsonStr}`);
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  console.log(`[Test] Fetched ${events.length} events`);
  return events;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!CLAUDE_CODE_AVAILABLE)("Claude Agent E2E", () => {
  beforeAll(async () => {
    console.log(`[Test] Claude Code CLI available: ${CLAUDE_CODE_AVAILABLE}`);
    await startServer();
  });

  afterAll(() => {
    stopServer();
  });

  it("should deliver events to multiple concurrent subscribers", async () => {
    const CONCURRENT_AGENT_PATH = `/claude/e2e-concurrent-${TEST_RUN_ID}`;

    const subscriber1Events: SSEEvent[] = [];
    const subscriber2Events: SSEEvent[] = [];
    const abortController1 = new AbortController();
    const abortController2 = new AbortController();

    let sub1ResultCount = 0;
    let sub2ResultCount = 0;

    // Start both SSE subscriptions concurrently
    const ssePromise1 = (async () => {
      console.log("[Test] Subscriber 1 connecting...");
      for await (const event of subscribeToSSE(CONCURRENT_AGENT_PATH, abortController1.signal)) {
        subscriber1Events.push(event);

        if (event.payload?.claudeEventType) {
          console.log(`[Test] Sub1 Claude Event: ${event.payload.claudeEventType}`);
          // Look for 'result' or 'assistant' events as completion signals
          if (
            event.payload.claudeEventType === "result" ||
            event.payload.claudeEventType === "assistant"
          ) {
            sub1ResultCount++;
            // After receiving both user acknowledgment and assistant response, we're done
            if (sub1ResultCount >= 2) {
              setTimeout(() => abortController1.abort(), 500);
            }
          }
        }
      }
    })();

    const ssePromise2 = (async () => {
      console.log("[Test] Subscriber 2 connecting...");
      for await (const event of subscribeToSSE(CONCURRENT_AGENT_PATH, abortController2.signal)) {
        subscriber2Events.push(event);

        if (event.payload?.claudeEventType) {
          console.log(`[Test] Sub2 Claude Event: ${event.payload.claudeEventType}`);
          if (
            event.payload.claudeEventType === "result" ||
            event.payload.claudeEventType === "assistant"
          ) {
            sub2ResultCount++;
            if (sub2ResultCount >= 2) {
              setTimeout(() => abortController2.abort(), 500);
            }
          }
        }
      }
    })();

    // Give SSE connections time to establish
    await new Promise((r) => setTimeout(r, 1000));
    console.log("[Test] Both subscribers connected, sending message...");

    // Send the user message
    await postUserMessage(CONCURRENT_AGENT_PATH, "what is 100 divided by 4");

    // Wait for both to complete with timeout
    const timeout = new Promise<void>((_, reject) => {
      setTimeout(() => {
        abortController1.abort();
        abortController2.abort();
        reject(new Error("Timeout"));
      }, 120_000); // Claude may take longer
    });

    try {
      await Promise.race([Promise.all([ssePromise1, ssePromise2]), timeout]);
    } catch (_err) {
      // Ignore abort/timeout errors
    }

    console.log(`[Test] Subscriber 1 received ${subscriber1Events.length} events`);
    console.log(`[Test] Subscriber 2 received ${subscriber2Events.length} events`);

    // ─────────────────────────────────────────────────────────────────────────
    // Assertions
    // ─────────────────────────────────────────────────────────────────────────

    // Both subscribers should have received events
    expect(subscriber1Events.length).toBeGreaterThan(0);
    expect(subscriber2Events.length).toBeGreaterThan(0);

    // Both should have received approximately the same number of events
    // (small difference allowed due to timing)
    const diff = Math.abs(subscriber1Events.length - subscriber2Events.length);
    console.log(`[Test] Event count difference: ${diff}`);
    expect(diff).toBeLessThanOrEqual(2);

    // Extract Claude event types from both
    const sub1ClaudeTypes = subscriber1Events
      .filter((e) => e.payload?.claudeEventType)
      .map((e) => e.payload!.claudeEventType);
    const sub2ClaudeTypes = subscriber2Events
      .filter((e) => e.payload?.claudeEventType)
      .map((e) => e.payload!.claudeEventType);

    console.log(`[Test] Sub1 Claude types: ${sub1ClaudeTypes.join(", ")}`);
    console.log(`[Test] Sub2 Claude types: ${sub2ClaudeTypes.join(", ")}`);

    // Both should have received the same Claude event types in the same order
    expect(sub1ClaudeTypes).toEqual(sub2ClaudeTypes);

    // Both should contain the answer "25"
    const sub1Content = JSON.stringify(subscriber1Events);
    const sub2Content = JSON.stringify(subscriber2Events);
    expect(sub1Content).toContain("25");
    expect(sub2Content).toContain("25");

    console.log("[Test] Concurrent subscribers test passed!");

    // ─────────────────────────────────────────────────────────────────────────
    // Subscriber 3: Late joiner fetching all historical events (no live)
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n[Test] === Subscriber 3: Late joiner with offset=-1 ===");

    const subscriber3Events = await fetchAllEvents(CONCURRENT_AGENT_PATH, "-1");

    console.log(`[Test] Subscriber 3 received ${subscriber3Events.length} events`);

    // Should have received a reasonable number of events
    // (live subscribers may include connection events that aren't persisted)
    expect(subscriber3Events.length).toBeGreaterThan(0);

    // Extract Claude event types
    const sub3ClaudeTypes = subscriber3Events
      .filter((e) => e.payload?.claudeEventType)
      .map((e) => e.payload!.claudeEventType);

    console.log(`[Test] Sub3 Claude types: ${sub3ClaudeTypes.join(", ")}`);

    // Should have at least one Claude event
    expect(sub3ClaudeTypes.length).toBeGreaterThan(0);

    // Should contain the answer "25"
    const sub3Content = JSON.stringify(subscriber3Events);
    expect(sub3Content).toContain("25");

    console.log("[Test] Late joiner (offset=-1) test passed!");

    // ─────────────────────────────────────────────────────────────────────────
    // Subscriber 4: Fetch with offset=last event (should get NO events)
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n[Test] === Subscriber 4: Fetch with offset=last event ===");

    // Get the last event's offset from subscriber 3 (which saw ALL events)
    const lastOffset = subscriber3Events[subscriber3Events.length - 1]?.offset;
    expect(lastOffset).toBeDefined();
    console.log(`[Test] Last event offset: ${lastOffset}`);

    const subscriber4Events = await fetchAllEvents(CONCURRENT_AGENT_PATH, lastOffset!);

    console.log(`[Test] Subscriber 4 received ${subscriber4Events.length} events`);

    // Should have received NO events (already past the last offset)
    expect(subscriber4Events.length).toBe(0);

    console.log("[Test] Fetch with last offset test passed!");
  });
});
