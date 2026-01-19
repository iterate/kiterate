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
import { PiSessionManager } from "./pi.js";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? "3001", 10);
const HOST = process.env.HOST ?? "127.0.0.1";
const DATA_DIR = process.env.DATA_DIR ?? path.resolve(__dirname, "../.iterate/agents");
const PI_SESSIONS_PATH = process.env.PI_SESSIONS_PATH ?? path.resolve(__dirname, "../.iterate/pi-sessions.yaml");

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[Server] Initializing with PI support...`);
  console.log(`[Server] Data directory: ${DATA_DIR}`);
  console.log(`[Server] PI sessions file: ${PI_SESSIONS_PATH}`);

  // Create store and basic app
  const store = new EventStore(DATA_DIR);
  const basicApp = createApp({ store });

  // Create PI session manager
  const piManager = new PiSessionManager(PI_SESSIONS_PATH, store);
  console.log(`[Server] PI session manager initialized`);

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

    // Let the basic app handle the POST
    const response = await basicApp.fetch(newRequest);
    
    // If successful, trigger PI adapter
    if (response.ok) {
      const agentPath = "/pi/" + c.req.param("path");
      try {
        await piManager.handleEvent(agentPath, body);
      } catch (err) {
        console.error(`[Server] Failed to handle PI event:`, err);
      }
    }

    return response;
  });

  // Forward all other requests to basic app
  app.all("*", (c) => basicApp.fetch(c.req.raw));

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
  POST /agents/pi/:name           - Events to /pi/* trigger PI adapter

Examples:
  curl -X POST http://localhost:${PORT}/agents/my-agent \\
    -H "Content-Type: application/json" \\
    -d '{"type": "message", "text": "hello"}'

  curl -X POST http://localhost:${PORT}/agents/pi/my-session \\
    -H "Content-Type: application/json" \\
    -d '{"type": "iterate:agent:action:send-user-message:called", "payload": {"content": "hello"}}'
`);
    }
  );
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
