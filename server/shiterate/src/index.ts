import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { streamSSE } from "hono/streaming";

import { createPiAdapter, type PiAdapterHandle } from "./backend/agents/pi/adapter.ts";
import {
  makePiErrorEvent,
  makePiEventReceivedEvent,
  makePromptEvent,
  makeSessionCreateEvent,
  type EventStreamId,
  type SessionCreatePayload,
} from "./backend/agents/pi/types.ts";

interface StoredEvent {
  offset: string;
  data: unknown;
  createdAt: string;
}

interface AgentState {
  streamName: string;
  eventStreamId: EventStreamId;
  adapter: PiAdapterHandle | null;
  createdAt: Date;
  events: StoredEvent[];
  nextOffset: number;
  subscribers: Set<(event: StoredEvent) => void>;
  sessionCreated: boolean;
}

const STREAM_OFFSET_HEADER = "Stream-Next-Offset";
const OFFSET_START = "-1";
const MAX_EVENTS = 1000;
const TRIM_TO_EVENTS = 500;

// Use global storage to survive HMR
declare global {
  var __daemon_agents: Map<string, AgentState> | undefined;
}

const agents = globalThis.__daemon_agents ?? new Map<string, AgentState>();
globalThis.__daemon_agents = agents;

function makeOffset(n: number): string {
  return String(n).padStart(16, "0");
}

function parseOffset(offset: string): number {
  if (offset === OFFSET_START) return -1;
  const parsed = Number.parseInt(offset, 10);
  return Number.isNaN(parsed) ? -1 : parsed;
}

function getStreamPathFromRequest(c: { req: { path: string; param?: (key: string) => string | undefined } }): string {
  const wildcard = c.req.param?.("*");
  if (wildcard && wildcard.length > 0) {
    return decodeURIComponent(wildcard);
  }

  const rawPath = c.req.path.replace(/^\/agents\//, "");
  return decodeURIComponent(rawPath);
}

function getOrCreateAgent(streamName: string): AgentState {
  const existing = agents.get(streamName);
  if (existing) return existing;

  const agent: AgentState = {
    streamName,
    eventStreamId: streamName as EventStreamId,
    adapter: null,
    createdAt: new Date(),
    events: [],
    nextOffset: 0,
    subscribers: new Set(),
    sessionCreated: false,
  };

  agents.set(streamName, agent);
  return agent;
}

function appendEvent(agent: AgentState, data: unknown): StoredEvent {
  const event: StoredEvent = {
    offset: makeOffset(agent.nextOffset),
    data,
    createdAt: new Date().toISOString(),
  };

  agent.nextOffset += 1;
  agent.events.push(event);

  if (agent.events.length > MAX_EVENTS) {
    agent.events = agent.events.slice(-TRIM_TO_EVENTS);
  }

  for (const subscriber of agent.subscribers) {
    subscriber(event);
  }

  return event;
}

function getEventsAfterOffset(agent: AgentState, offset: string): StoredEvent[] {
  const numericOffset = parseOffset(offset);
  if (numericOffset < 0) return agent.events;
  return agent.events.filter((event) => parseOffset(event.offset) > numericOffset);
}

function getOrCreateAdapter(agent: AgentState): PiAdapterHandle {
  if (agent.adapter) return agent.adapter;

  agent.adapter = createPiAdapter({
    onEvent: (event) => {
      appendEvent(agent, makePiEventReceivedEvent(agent.eventStreamId, event.type, event));
    },
    onError: (error, context) => {
      appendEvent(agent, makePiErrorEvent(agent.eventStreamId, error, context));
    },
    onSessionCreate: (payload: SessionCreatePayload) => {
      if (agent.sessionCreated) return;
      agent.sessionCreated = true;
      appendEvent(
        agent,
        makeSessionCreateEvent(agent.eventStreamId, {
          cwd: payload.cwd,
          model: payload.model,
          thinkingLevel: payload.thinkingLevel,
          sessionFile: payload.sessionFile,
        }),
      );
    },
  });

  return agent.adapter;
}

const app = new Hono();

app.use("*", logger());
app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.post("/agents/*", async (c) => {
  const streamPath = getStreamPathFromRequest(c);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.text("Invalid JSON", 400);
  }

  let messageText: string;
  if (typeof body === "string") {
    messageText = body;
  } else if (typeof body === "object" && body !== null) {
    const obj = body as Record<string, unknown>;
    messageText = String(obj.text ?? obj.message ?? obj.prompt ?? JSON.stringify(body));
  } else {
    messageText = String(body);
  }

  const agent = getOrCreateAgent(streamPath);
  const adapter = getOrCreateAdapter(agent);

  const promptEvent = makePromptEvent(agent.eventStreamId, messageText);
  const storedEvent = appendEvent(agent, promptEvent);

  await adapter.prompt(messageText);

  return new Response(null, {
    status: 200,
    headers: { [STREAM_OFFSET_HEADER]: storedEvent.offset },
  });
});

app.get("/agents/*", (c) => {
  const streamPath = getStreamPathFromRequest(c);
  const offset = c.req.query("offset") ?? OFFSET_START;
  const live = c.req.query("live");

  if (live && live !== "sse") {
    return c.text("Only SSE mode supported", 400);
  }

  return streamSSE(c, async (stream) => {
    const agent = getOrCreateAgent(streamPath);

    let lastOffset = offset;

    const sendEvent = (event: StoredEvent) => {
      lastOffset = event.offset;

      const payload =
        typeof event.data === "object" && event.data !== null
          ? "offset" in (event.data as Record<string, unknown>)
            ? event.data
            : { ...(event.data as Record<string, unknown>), offset: event.offset }
          : { data: event.data, offset: event.offset };

      stream.writeSSE({ event: "data", data: JSON.stringify([payload]) });
      stream.writeSSE({
        event: "control",
        data: JSON.stringify({ streamNextOffset: lastOffset, upToDate: true }),
      });
    };

    const backlog = getEventsAfterOffset(agent, offset);
    for (const event of backlog) {
      sendEvent(event);
    }

    if (backlog.length === 0) {
      const currentOffset = agent.events.length > 0 ? agent.events[agent.events.length - 1].offset : "0";
      stream.writeSSE({
        event: "control",
        data: JSON.stringify({ streamNextOffset: currentOffset, upToDate: true }),
      });
    }

    const subscriber = (event: StoredEvent) => {
      sendEvent(event);
    };

    agent.subscribers.add(subscriber);

    await new Promise<void>((resolve) => {
      c.req.raw.signal.addEventListener("abort", () => {
        agent.subscribers.delete(subscriber);
        resolve();
      });
    });
  });
});

app.delete("/agents/*", async (c) => {
  const streamPath = getStreamPathFromRequest(c);
  const agent = agents.get(streamPath);

  if (!agent) {
    return c.text("Agent not found", 404);
  }

  if (agent.adapter) {
    await agent.adapter.close();
  }

  agents.delete(streamPath);
  return new Response(null, { status: 204 });
});

app.on("HEAD", "/agents/*", (c) => {
  const streamPath = getStreamPathFromRequest(c);

  if (!agents.has(streamPath)) {
    return new Response("Agent not found", { status: 404 });
  }

  return new Response(null, {
    status: 200,
    headers: {
      [STREAM_OFFSET_HEADER]: "0",
      "Content-Type": "application/json",
    },
  });
});

const PORT = parseInt(process.env.PORT ?? "3001", 10);

console.log(`🚀 Shiterate server starting on port ${PORT}...`);

serve({
  fetch: app.fetch,
  port: PORT,
});

console.log(`✅ Server running at http://localhost:${PORT}`);
