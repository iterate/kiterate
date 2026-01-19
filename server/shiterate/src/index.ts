/**
 * Shiterate Server
 *
 * A thin wrapper around DurableStreamTestServer that:
 * - Auto-creates streams on 404 (implicit creation - convenient for dev, may not be suitable for production)
 * - Hooks POST to /agents/pi/* to trigger the PI adapter
 */
import { createServer, type IncomingMessage } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DurableStreamTestServer } from "@durable-streams/server";
import { PiSessionManager } from "./pi.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? "3001", 10);
const HOST = process.env.HOST ?? "127.0.0.1";
const STREAMS_PATH = process.env.STREAMS_PATH ?? path.resolve(__dirname, "../.iterate/streams");
const PI_SESSIONS_PATH = process.env.PI_SESSIONS_PATH ?? path.resolve(__dirname, "../.iterate/pi-sessions.yaml");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[Server] Initializing...`);
  console.log(`[Server] Streams path: ${STREAMS_PATH}`);

  // Ensure streams directory exists
  if (!fs.existsSync(STREAMS_PATH)) {
    fs.mkdirSync(STREAMS_PATH, { recursive: true });
  }

  // Start the wrapped DurableStreamTestServer on an internal port
  const dsServer = new DurableStreamTestServer({ dataDir: STREAMS_PATH, port: 0 });
  const baseUrl = await dsServer.start();
  console.log(`[Server] DurableStreamTestServer started at ${baseUrl}`);

  // Initialize PI session manager with the store
  // Sessions are loaded lazily when someone accesses the agent path (not on startup)
  const piManager = new PiSessionManager(PI_SESSIONS_PATH, dsServer.store);
  console.log(`[Server] PI session manager initialized (sessions loaded lazily)`);

  // Create wrapper server
  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const reqUrl = req.url ?? "/";
    const url = baseUrl + reqUrl;

    // Read body for POST/PUT
    const body = method === "POST" || method === "PUT" ? await readBody(req) : undefined;

    // Forward request to wrapped server
    let response = await fetch(url, {
      method,
      headers: Object.fromEntries(
        Object.entries(req.headers)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v!]),
      ),
      body,
    });

    // Auto-create streams on 404 for GET/POST
    // NOTE: Implicit creation is convenient for dev but may not be suitable for production
    if (response.status === 404 && (method === "GET" || method === "POST")) {
      await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" } });
      response = await fetch(url, {
        method,
        headers: Object.fromEntries(
          Object.entries(req.headers)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v!]),
        ),
        body,
      });
    }

    // After successful POST to /agents/pi/*, trigger PI adapter
    if (method === "POST" && response.ok && reqUrl.startsWith("/agents/pi/")) {
      const agentPath = reqUrl.replace(/^\/agents/, "").split("?")[0];
      try {
        const event = JSON.parse(new TextDecoder().decode(body));
        await piManager.handleEvent(agentPath, event);
      } catch (err) {
        console.error(`[Server] Failed to handle PI event:`, err);
      }
    }

    // Log request
    console.log(`${method} ${reqUrl} -> ${response.status}`);

    // Pipe response back - stream SSE responses, buffer others
    const contentType = response.headers.get("content-type") ?? "";
    
    if (contentType.includes("text/event-stream") && response.body) {
      // For SSE, set proper headers to disable buffering
      const headers = Object.fromEntries(response.headers);
      // Add headers to prevent buffering at various levels
      headers["cache-control"] = "no-cache";
      headers["x-accel-buffering"] = "no";
      // Ensure connection stays open
      headers["connection"] = "keep-alive";
      
      res.writeHead(response.status, headers);
      
      // Stream SSE responses in real-time with immediate flushing
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // Write and flush immediately for real-time streaming
          const written = res.write(value);
          // If the write buffer is full, wait for it to drain
          if (!written) {
            await new Promise<void>((resolve) => res.once("drain", resolve));
          }
        }
      } catch {
        // Client disconnected
      } finally {
        res.end();
      }
    } else {
      res.writeHead(response.status, Object.fromEntries(response.headers));
      // Buffer non-SSE responses
      res.end(Buffer.from(await response.arrayBuffer()));
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`[Server] Running at http://${HOST}:${PORT}`);
    console.log(`
Durable Streams Protocol Endpoints (via DurableStreamTestServer):
  PUT    /agents/:path              - Create stream
  POST   /agents/:path              - Append event(s) to stream
  GET    /agents/:path?offset=X&live=sse - Subscribe to stream (SSE)
  DELETE /agents/:path              - Delete stream
  HEAD   /agents/:path              - Get stream metadata

PI Agent Streams:
  POST   /agents/pi/:name           - Events to /pi/* streams trigger PI adapter

Streams are auto-created on 404 for GET/POST requests.
`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
