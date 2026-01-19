/**
 * Basic Event Stream Server with PI Integration
 *
 * Wraps the basic server and adds PI agent support for /agents/pi/* paths.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, EventStore } from "@kiterate/server-basic";
import { PiAdapter } from "./pi.js";

// ─────────────────────────────────────────────────────────────────────────────
// Global Error Handlers - Catch crashes before they kill the process
// ─────────────────────────────────────────────────────────────────────────────

process.on("unhandledRejection", (reason, promise) => {
  console.error("[Server] UNHANDLED REJECTION:", reason);
  console.error("[Server] Promise:", promise);
});

process.on("uncaughtException", (error) => {
  console.error("[Server] UNCAUGHT EXCEPTION:", error);
  // Don't exit - let the server keep running if possible
});

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? "3001", 10);
const HOST = process.env.HOST ?? "127.0.0.1";
const DATA_DIR = process.env.DATA_DIR ?? path.resolve(__dirname, "../.iterate/agents");
const PI_SESSIONS_FILE = process.env.PI_SESSIONS_FILE ?? path.resolve(__dirname, "../.iterate/pi-sessions.yaml");

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[Server] Initializing with PI support...`);
  console.log(`[Server] Data directory: ${DATA_DIR}`);
  console.log(`[Server] PI sessions file: ${PI_SESSIONS_FILE}`);

  // Create store and basic app
  const store = new EventStore(DATA_DIR);
  const basicApp = createApp({ store });

  // Create PI adapter - when PI emits events, append them to the store
  const piAdapter = new PiAdapter({
    append: (agentPath, event) => store.append(agentPath, event),
    sessionsFile: PI_SESSIONS_FILE,
  });

  // Load existing sessions
  await piAdapter.loadSessions();

  // Create wrapper app with PI middleware
  const app = new Hono();

  // Intercept POST to /agents/pi/* to trigger PI adapter AFTER the event is stored
  app.post("/agents/pi/:path{.+}", async (c) => {
    // Read body first (can only be read once)
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.text("Invalid JSON", 400);
    }

    // Create a new request with the body for the basic app
    const newRequest = new Request(c.req.raw.url, {
      method: "POST",
      headers: c.req.raw.headers,
      body: JSON.stringify(body),
    });

    // Let the basic app handle the POST (stores the event)
    const response = await basicApp.fetch(newRequest);

    // If successful, trigger PI adapter
    if (response.ok) {
      const agentPath = "/pi/" + c.req.param("path");
      try {
        await piAdapter.on(agentPath, body);
      } catch (err) {
        console.error(`[Server] PI adapter error for ${agentPath}:`, err);
      }
    }

    return response;
  });

  // Forward all other requests to basic app
  app.all("*", (c) => basicApp.fetch(c.req.raw));

  // Graceful shutdown
  process.on("SIGTERM", () => {
    console.log("[Server] Shutting down...");
    piAdapter.closeAll();
    process.exit(0);
  });

  serve(
    {
      fetch: app.fetch,
      port: PORT,
      hostname: HOST,
    },
    (info) => {
      console.log(`[Server] Running at http://${HOST}:${info.port}`);
      console.log(`
Endpoints:
  POST /agents/:path              - Append event (auto-creates stream)
  GET  /agents/:path              - Read all events as JSON array
  GET  /agents/:path?offset=X     - Read events from offset
  GET  /agents/:path?live=sse     - Subscribe to events (SSE)

PI Agent Streams:
  POST /agents/pi/:name           - Events trigger PI adapter

Example:
  curl -X POST http://localhost:${PORT}/agents/pi/my-session \\
    -H "Content-Type: application/json" \\
    -d '{"type": "user-message", "content": "hello"}'
`);
    }
  );
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
