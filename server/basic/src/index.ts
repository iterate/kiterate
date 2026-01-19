/**
 * Basic Event Stream Server - Entry Point
 *
 * Standalone server that serves the basic Hono app.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp, EventStore } from "./app.js";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? "3001", 10);
const HOST = process.env.HOST ?? "127.0.0.1";
const DATA_DIR = process.env.DATA_DIR ?? path.resolve(__dirname, "../.iterate/agents");

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[Server] Initializing...`);
  console.log(`[Server] Data directory: ${DATA_DIR}`);

  const store = new EventStore(DATA_DIR);
  const app = createApp({ store });

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
  GET  /agents/:path              - Stream all events (SSE), then close
  GET  /agents/:path?offset=X     - Stream events from offset (SSE), then close
  GET  /agents/:path?live=sse     - Stream events (SSE), keep connection open

Examples:
  # Post an event
  curl -X POST http://localhost:${PORT}/agents/my-agent \\
    -H "Content-Type: application/json" \\
    -d '{"type": "message", "text": "hello"}'

  # Stream all existing events (connection closes after last event)
  curl "http://localhost:${PORT}/agents/my-agent"

  # Subscribe to live events (connection stays open)
  curl "http://localhost:${PORT}/agents/my-agent?live=sse"
`);
    },
  );
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
