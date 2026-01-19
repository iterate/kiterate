/**
 * Basic Event Stream Server with PI Integration
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createApp, EventStore } from "@kiterate/server-basic";
import { PiAdapter } from "./pi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? "3001", 10);
const HOST = process.env.HOST ?? "127.0.0.1";
const DATA_DIR = process.env.DATA_DIR ?? path.resolve(__dirname, "../.iterate/agents");
const PI_SESSIONS_FILE =
  process.env.PI_SESSIONS_FILE ?? path.resolve(__dirname, "../.iterate/pi-sessions.yaml");

async function main() {
  const store = new EventStore(DATA_DIR);
  const basicApp = createApp({ store });

  const piAdapter = new PiAdapter({
    append: (agentPath, event) => store.append(agentPath, event),
    sessionsFile: PI_SESSIONS_FILE,
  });
  await piAdapter.loadSessions();

  const app = new Hono();

  // Intercept POST to /agents/pi/* to trigger PI adapter after event is stored
  app.post("/agents/pi/:path{.+}", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.text("Invalid JSON", 400);
    }

    const response = await basicApp.fetch(
      new Request(c.req.raw.url, {
        method: "POST",
        headers: c.req.raw.headers,
        body: JSON.stringify(body),
      }),
    );

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

  app.all("*", (c) => basicApp.fetch(c.req.raw));

  process.on("SIGTERM", () => {
    piAdapter.closeAll();
    process.exit(0);
  });

  serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
    console.log(`[Server] http://${HOST}:${info.port} (PI enabled)`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
