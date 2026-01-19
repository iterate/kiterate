/**
 * Basic Event Stream Server - Hono App
 *
 * Simple HTTP API for event streams:
 * - POST /agents/:path - Append event (auto-creates stream)
 * - GET /agents/:path - Read events (supports SSE with live=sse)
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
  // GET /agents/* - Read events
  // ─────────────────────────────────────────────────────────────────────────────

  app.get("/agents/:path{.+}", async (c) => {
    const agentPath = "/" + c.req.param("path");
    const offset = c.req.query("offset") ?? "-1";
    const live = c.req.query("live");

    // Ensure stream exists (auto-create)
    store.getOrCreate(agentPath);

    // SSE mode
    if (live === "sse") {
      return streamSSE(c, async (stream) => {
        let currentOffset = offset;
        const TIMEOUT_MS = 30_000;

        // Send all existing events first
        const { events } = store.read(agentPath, currentOffset);
        for (const event of events) {
          await stream.writeSSE({
            event: "data",
            data: JSON.stringify(eventWithOffset(event)),
          });
          currentOffset = event.offset;
        }

        // Keep connection open for live updates
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
    }

    // Non-SSE: return JSON array
    const { events } = store.read(agentPath, offset);
    const eventsWithOffsets = events.map(eventWithOffset);
    
    return c.json(eventsWithOffsets);
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
