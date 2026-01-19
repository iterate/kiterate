/**
 * Basic Event Stream Server - Hono App
 *
 * Simple HTTP API for event streams:
 * - POST /agents/:path - Append event (auto-creates stream)
 * - GET /agents/:path - Read events as SSE stream (closes after last event)
 * - GET /agents/:path?live=sse - Read events as SSE stream (keeps connection open)
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { EventStore, type StoredEvent } from "./store.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AppConfig {
  store: EventStore;
}

// ─────────────────────────────────────────────────────────────────────────────
// App Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createApp(config: AppConfig): Hono {
  const { store } = config;
  const app = new Hono();

  // CORS for browser access
  app.use("*", cors());

  // Health check
  app.get("/", (c) => c.text("OK"));

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /agents/* - Append event
  // ─────────────────────────────────────────────────────────────────────────────

  app.post("/agents/:path{.+}", async (c) => {
    const agentPath = "/" + c.req.param("path");
    
    let eventData: unknown;
    try {
      eventData = await c.req.json();
    } catch {
      return c.text("Invalid JSON", 400);
    }

    // Inject createdAt if not present
    if (typeof eventData === "object" && eventData !== null && !("createdAt" in eventData)) {
      (eventData as Record<string, unknown>).createdAt = new Date().toISOString();
    }

    const result = store.append(agentPath, eventData);
    
    return c.json({ ok: true, offset: result.offset }, 200);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /agents/* - Read events (always SSE)
  // ─────────────────────────────────────────────────────────────────────────────

  app.get("/agents/:path{.+}", async (c) => {
    const agentPath = "/" + c.req.param("path");
    const offset = c.req.query("offset") ?? "-1";
    const live = c.req.query("live");

    // Validate live parameter
    if (live !== undefined && live !== "sse") {
      return c.json(
        {
          error: "Invalid 'live' parameter",
          message: `The 'live' query parameter must be either omitted or set to 'sse'. Got: '${live}'`,
          validOptions: {
            omitted: "Stream all existing events, then close connection",
            sse: "Stream all existing events and keep connection open for live updates",
          },
        },
        400
      );
    }

    // Ensure stream exists (auto-create)
    store.getOrCreate(agentPath);

    // Always return SSE stream
    return streamSSE(c, async (stream) => {
      let currentOffset = offset;

      // Send all existing events first
      const { events } = store.read(agentPath, currentOffset);
      for (const event of events) {
        await stream.writeSSE({
          event: "data",
          data: JSON.stringify(eventWithOffset(event)),
        });
        currentOffset = event.offset;
      }

      // If not live mode, close the stream after sending all events
      if (live !== "sse") {
        return;
      }

      // Keep connection open for live updates
      const TIMEOUT_MS = 30_000;
      while (true) {
        const hasNew = await store.waitForEvents(agentPath, currentOffset, TIMEOUT_MS);

        if (hasNew) {
          const { events: newEvents } = store.read(agentPath, currentOffset);
          for (const event of newEvents) {
            await stream.writeSSE({
              event: "data",
              data: JSON.stringify(eventWithOffset(event)),
            });
            currentOffset = event.offset;
          }
        }
        // On timeout, just keep waiting (connection stays open)
      }
    });
  });

  return app;
}

/**
 * Convert stored event to output format with offset included
 */
function eventWithOffset(event: StoredEvent): unknown {
  const data = event.data as Record<string, unknown>;
  return {
    ...data,
    offset: event.offset,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

export { EventStore } from "./store.js";
