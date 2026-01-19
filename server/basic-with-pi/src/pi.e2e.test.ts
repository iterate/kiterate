/**
 * E2E test for PI Agent
 *
 * Tests that:
 * - Multiple concurrent SSE subscribers receive the same events
 * - PI agent can process a simple math question
 * - Returns the correct answer with expected events
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { ChildProcess, spawn } from "node:child_process";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const SERVER_PORT = process.env.TEST_PORT ?? "3099";
const SERVER_HOST = "127.0.0.1";
const SERVER_URL = `http://${SERVER_HOST}:${SERVER_PORT}`;

// Use unique agent path per test run to avoid conflicts
const TEST_RUN_ID = Date.now();

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface SSEEvent {
  type?: string;
  offset?: string;
  payload?: {
    piEventType?: string;
    piEvent?: {
      type: string;
      content?: string;
      text?: string;
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

async function* subscribeToSSE(
  path: string,
  signal: AbortSignal
): AsyncGenerator<SSEEvent> {
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
            } catch (err) {
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

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("PI Agent E2E", () => {
  beforeAll(async () => {
    await startServer();
  });

  afterAll(() => {
    stopServer();
  });

  it("should deliver events to multiple concurrent subscribers", async () => {
    const CONCURRENT_AGENT_PATH = `/pi/e2e-concurrent-${TEST_RUN_ID}`;
    
    const subscriber1Events: SSEEvent[] = [];
    const subscriber2Events: SSEEvent[] = [];
    const abortController1 = new AbortController();
    const abortController2 = new AbortController();

    let sub1MessageEndCount = 0;
    let sub2MessageEndCount = 0;

    // Start both SSE subscriptions concurrently
    const ssePromise1 = (async () => {
      console.log("[Test] Subscriber 1 connecting...");
      for await (const event of subscribeToSSE(CONCURRENT_AGENT_PATH, abortController1.signal)) {
        subscriber1Events.push(event);
        
        if (event.payload?.piEventType) {
          console.log(`[Test] Sub1 PI Event: ${event.payload.piEventType}`);
          if (event.payload.piEventType === "message_end") {
            sub1MessageEndCount++;
            if (sub1MessageEndCount >= 2) {
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
        
        if (event.payload?.piEventType) {
          console.log(`[Test] Sub2 PI Event: ${event.payload.piEventType}`);
          if (event.payload.piEventType === "message_end") {
            sub2MessageEndCount++;
            if (sub2MessageEndCount >= 2) {
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
      }, 60_000);
    });

    try {
      await Promise.race([
        Promise.all([ssePromise1, ssePromise2]),
        timeout,
      ]);
    } catch (err) {
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

    // Extract PI event types from both
    const sub1PiTypes = subscriber1Events
      .filter((e) => e.payload?.piEventType)
      .map((e) => e.payload!.piEventType);
    const sub2PiTypes = subscriber2Events
      .filter((e) => e.payload?.piEventType)
      .map((e) => e.payload!.piEventType);

    console.log(`[Test] Sub1 PI types: ${sub1PiTypes.join(", ")}`);
    console.log(`[Test] Sub2 PI types: ${sub2PiTypes.join(", ")}`);

    // Both should have received the same PI event types in the same order
    expect(sub1PiTypes).toEqual(sub2PiTypes);

    // Both should contain the answer "25"
    const sub1Content = JSON.stringify(subscriber1Events);
    const sub2Content = JSON.stringify(subscriber2Events);
    expect(sub1Content).toContain("25");
    expect(sub2Content).toContain("25");

    console.log("[Test] Concurrent subscribers test passed!");
  });
});
