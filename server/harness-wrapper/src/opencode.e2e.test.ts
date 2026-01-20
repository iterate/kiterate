/**
 * E2E test for OpenCode Agent
 *
 * Tests that:
 * - Multiple concurrent SSE subscribers receive the same events
 * - OpenCode agent can process a simple math question
 * - Returns the correct answer with expected events
 *
 * Requirements:
 * - OPENCODE_BASE_URL environment variable must be set to a running OpenCode server
 */
import { ChildProcess, spawn } from "node:child_process";
import { describe, it, expect, afterAll, beforeAll } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const SERVER_PORT = process.env.TEST_PORT ?? "3099";
const SERVER_HOST = "127.0.0.1";
const SERVER_URL = `http://${SERVER_HOST}:${SERVER_PORT}`;

// Check if OpenCode server is reachable
const OPENCODE_BASE_URL = process.env.OPENCODE_BASE_URL ?? "http://localhost:4096";
const EXPECTED_ANSWER = "25";

async function isOpenCodeServerReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${OPENCODE_BASE_URL}/`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function hasConfiguredProviders(): Promise<boolean> {
  try {
    const response = await fetch(`${OPENCODE_BASE_URL}/config/providers`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;
    const data = (await response.json()) as {
      providers?: unknown;
    };
    const providers = data?.providers;
    if (Array.isArray(providers)) return providers.length > 0;
    if (providers && typeof providers === "object") return Object.keys(providers).length > 0;
    return false;
  } catch {
    return false;
  }
}

// Will be set in beforeAll - start with false to skip if check fails
let OPENCODE_AVAILABLE = false;

// Use unique agent path per test run to avoid conflicts
const TEST_RUN_ID = Date.now();

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface SSEEvent {
  type?: string;
  offset?: string;
  payload?: {
    openCodeEventType?: string;
    openCodeEvent?: {
      type: string;
      properties?: {
        info?: {
          role?: string;
          content?: string;
          parts?: Array<{ type: string; text?: string }>;
        };
        [key: string]: unknown;
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
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return;
    }
    throw err;
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

describe("OpenCode Agent E2E", () => {
  beforeAll(async () => {
    OPENCODE_AVAILABLE = await isOpenCodeServerReachable();
    console.log(`[Test] OPENCODE_BASE_URL: ${OPENCODE_BASE_URL}`);
    console.log(`[Test] OpenCode server reachable: ${OPENCODE_AVAILABLE}`);
    if (OPENCODE_AVAILABLE) {
      const configured = await hasConfiguredProviders();
      console.log(`[Test] OpenCode providers configured: ${configured}`);
      if (!configured) {
        OPENCODE_AVAILABLE = false;
        console.warn(
          "[Test] Skipping OpenCode E2E - no providers configured (check API keys/config)",
        );
      }
    }
    if (OPENCODE_AVAILABLE) {
      await startServer();
    }
  });

  afterAll(() => {
    stopServer();
  });

  it("should deliver events to multiple concurrent subscribers", async ({ skip }) => {
    if (!OPENCODE_AVAILABLE) {
      skip();
      return;
    }

    const CONCURRENT_AGENT_PATH = `/opencode/e2e-concurrent-${TEST_RUN_ID}`;

    const subscriber1Events: SSEEvent[] = [];
    const subscriber2Events: SSEEvent[] = [];
    const abortController1 = new AbortController();
    const abortController2 = new AbortController();

    let sub1AnswerSeen = false;
    let sub2AnswerSeen = false;

    // Start both SSE subscriptions concurrently
    const ssePromise1 = (async () => {
      console.log("[Test] Subscriber 1 connecting...");
      for await (const event of subscribeToSSE(CONCURRENT_AGENT_PATH, abortController1.signal)) {
        subscriber1Events.push(event);

        if (event.payload?.openCodeEventType) {
          console.log(`[Test] Sub1 OpenCode Event: ${event.payload.openCodeEventType}`);
          if (event.payload.openCodeEventType === "message.part.updated") {
            const partText = event.payload.openCodeEvent?.properties?.part?.text;
            if (typeof partText === "string" && partText.includes(EXPECTED_ANSWER)) {
              sub1AnswerSeen = true;
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

        if (event.payload?.openCodeEventType) {
          console.log(`[Test] Sub2 OpenCode Event: ${event.payload.openCodeEventType}`);
          if (event.payload.openCodeEventType === "message.part.updated") {
            const partText = event.payload.openCodeEvent?.properties?.part?.text;
            if (typeof partText === "string" && partText.includes(EXPECTED_ANSWER)) {
              sub2AnswerSeen = true;
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
      }, 120_000); // OpenCode may take longer
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

    // Extract OpenCode event types from both
    const sub1OpenCodeTypes = subscriber1Events
      .filter((e) => e.payload?.openCodeEventType)
      .map((e) => e.payload!.openCodeEventType);
    const sub2OpenCodeTypes = subscriber2Events
      .filter((e) => e.payload?.openCodeEventType)
      .map((e) => e.payload!.openCodeEventType);

    console.log(`[Test] Sub1 OpenCode types: ${sub1OpenCodeTypes.join(", ")}`);
    console.log(`[Test] Sub2 OpenCode types: ${sub2OpenCodeTypes.join(", ")}`);

    // Both should have received the same OpenCode event types in the same order
    expect(sub1OpenCodeTypes).toEqual(sub2OpenCodeTypes);

    // Both should contain the answer "25"
    const sub1Content = JSON.stringify(subscriber1Events);
    const sub2Content = JSON.stringify(subscriber2Events);
    expect(sub1AnswerSeen).toBe(true);
    expect(sub2AnswerSeen).toBe(true);
    expect(sub1Content).toContain(EXPECTED_ANSWER);
    expect(sub2Content).toContain(EXPECTED_ANSWER);

    console.log("[Test] Concurrent subscribers test passed!");

    // ─────────────────────────────────────────────────────────────────────────
    // Subscriber 3: Late joiner fetching all historical events (no live)
    // ─────────────────────────────────────────────────────────────────────────
    console.log("\n[Test] === Subscriber 3: Late joiner with offset=-1 ===");

    const subscriber3Events = await fetchAllEvents(CONCURRENT_AGENT_PATH, "-1");

    console.log(`[Test] Subscriber 3 received ${subscriber3Events.length} events`);

    // Should have received at least as many events as the live subscribers
    // (live subscribers may have aborted before receiving all events)
    expect(subscriber3Events.length).toBeGreaterThanOrEqual(subscriber1Events.length);

    // Extract OpenCode event types
    const sub3OpenCodeTypes = subscriber3Events
      .filter((e) => e.payload?.openCodeEventType)
      .map((e) => e.payload!.openCodeEventType);

    console.log(`[Test] Sub3 OpenCode types: ${sub3OpenCodeTypes.join(", ")}`);

    // Should have at least one OpenCode event
    expect(sub3OpenCodeTypes.length).toBeGreaterThan(0);

    // Should contain the answer "25"
    const sub3Content = JSON.stringify(subscriber3Events);
    expect(sub3Content).toContain(EXPECTED_ANSWER);

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
