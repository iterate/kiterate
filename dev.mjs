import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";

// Usage: pnpm dev [backend] [frontend]
// Defaults: backend=basic, frontend=basic

const DEFAULT_BACKEND = "basic";
const DEFAULT_FRONTEND = "basic";
const DEFAULT_BACKEND_PORT = 3001;

const backendArg = process.argv[2] ?? DEFAULT_BACKEND;
const frontendArg = process.argv[3] ?? DEFAULT_FRONTEND;

const children = [];

function spawnPnpm(args, extraEnv = {}) {
  const isWindows = process.platform === "win32";
  const child = spawn("pnpm", args, {
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
    shell: isWindows,
    detached: !isWindows, // Create process group on Unix
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  const isWindows = process.platform === "win32";
  for (const child of children) {
    if (!child.killed) {
      if (isWindows) {
        child.kill("SIGTERM");
      } else {
        // Kill the entire process group
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // Process may already be dead
        }
      }
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function listDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function ensureDirExists(kind, root, name) {
  const available = listDirs(root);
  if (!available.includes(name)) {
    console.error(`Unknown ${kind} "${name}". Available: ${available.join(", ") || "none"}`);
    process.exit(1);
  }
}

ensureDirExists("backend", "server", backendArg);
ensureDirExists("frontend", "web", frontendArg);

const serverPkg = `./server/${backendArg}`;
const webPkg = `./web/${frontendArg}`;

async function checkPortOnHost(port, host) {
  return new Promise((resolve, reject) => {
    const server = net
      .createServer()
      .once("error", (error) => {
        if (error.code === "EADDRINUSE") {
          resolve("inuse");
          return;
        }
        if (error.code === "EADDRNOTAVAIL" || error.code === "EINVAL") {
          resolve("unsupported");
          return;
        }
        reject(error);
      })
      .once("listening", () => {
        server.close(() => resolve("available"));
      })
      .listen(port, host);
  });
}

async function isPortAvailable(port) {
  const ipv6Status = await checkPortOnHost(port, "::");
  if (ipv6Status === "available") {
    return true;
  }
  if (ipv6Status === "inuse") {
    return false;
  }

  const ipv4Status = await checkPortOnHost(port, "0.0.0.0");
  return ipv4Status === "available";
}

async function findAvailablePort(startPort, maxPort = 65535) {
  let port = startPort;
  while (port <= maxPort) {
    if (await isPortAvailable(port)) {
      return port;
    }
    port += 1;
  }
  throw new Error(`No available port found between ${startPort} and ${maxPort}.`);
}

async function main() {
  const backendPort = await findAvailablePort(DEFAULT_BACKEND_PORT);
  const backendPortLabel =
    backendPort === DEFAULT_BACKEND_PORT
      ? backendPort
      : `${DEFAULT_BACKEND_PORT} (busy, using ${backendPort})`;

  console.log(
    `Starting: backend=${backendArg} (${serverPkg}) on ${backendPortLabel}, frontend=${frontendArg} (${webPkg})`,
  );

  // Start server
  spawnPnpm(["--filter", serverPkg, "dev"], { PORT: String(backendPort) });

  // Start web frontend (port 3000)
  spawnPnpm(["--filter", webPkg, "dev"], { BACKEND_PORT: String(backendPort) });

  for (const child of children) {
    child.on("exit", (code) => {
      if (code && code !== 0) shutdown(code);
    });
  }
}

main().catch((error) => {
  console.error("Failed to start dev servers:", error);
  shutdown(1);
});
