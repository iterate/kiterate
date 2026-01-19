/**
 * Durable Streams Reference Server
 *
 * A super vanilla durable-streams backend with purely in-memory streams.
 * Uses the official @durable-streams/server test server implementation.
 *
 * Streams can be accessed at any path, including /agents/*
 *
 * Durable Streams Protocol Endpoints:
 * - PUT /:path - Create stream (optional, auto-created on first POST)
 * - POST /:path - Append event to stream
 * - GET /:path?offset=X&live=sse - Subscribe to stream (SSE)
 * - DELETE /:path - Delete stream
 * - HEAD /:path - Get stream metadata
 */
import { DurableStreamTestServer } from "@durable-streams/server";

const PORT = parseInt(process.env.PORT ?? "3001", 10);
const HOST = process.env.HOST ?? "127.0.0.1";

// Create the test server with in-memory storage
// The DurableStreamTestServer provides a complete protocol-compliant implementation
const server = new DurableStreamTestServer({
  port: PORT,
  host: HOST,
});

// Start the server (async)
async function main() {
  const url = await server.start();
  console.log(`🚀 Durable Streams Reference Server running at ${url}`);
  console.log(`
This is the official durable-streams test server with in-memory storage.
Use any path to create/access streams (e.g., /agents/my-agent)

Durable Streams Protocol Endpoints:
  PUT    /:path                    - Create stream (optional)
  POST   /:path                    - Append event(s) to stream
  GET    /:path?offset=X&live=sse  - Subscribe to stream (SSE)
  DELETE /:path                    - Delete stream
  HEAD   /:path                    - Get stream metadata

Example usage:
  curl -X POST ${url}/agents/my-agent -d '{"type":"message","text":"hello"}'
  curl "${url}/agents/my-agent?offset=-1&live=sse"
`);
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
