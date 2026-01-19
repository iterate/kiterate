/**
 * Basic Event Stream Server - Entry Point
 *
 * Standalone server that serves the basic Hono app.
 */
import { serve } from "@hono/node-server";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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
  GET  /agents/:path              - Read all events as JSON array
  GET  /agents/:path?offset=X     - Read events from offset
  GET  /agents/:path?live=sse     - Subscribe to events (SSE)

Examples:
  curl -X POST http://localhost:${PORT}/agents/my-agent \\
    -H "Content-Type: application/json" \\
    -d '{"type": "message", "text": "hello"}'

  curl "http://localhost:${PORT}/agents/my-agent?offset=-1&live=sse"
`);
    }
  );
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
