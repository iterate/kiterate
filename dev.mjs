import { execSync, spawn } from "node:child_process";
import fs from "node:fs";

// Usage: pnpm dev [backend] [frontend]
// Defaults: backend=durable-stream, frontend=basic

const BACKEND_PORT = 3001;
const FRONTEND_PORT = 3000;

const backendArg = process.argv[2] ?? "durable-stream";
const frontendArg = process.argv[3] ?? "basic";

const children = [];

function killPort(port) {
  if (process.platform === "win32") {
    try {
      const result = execSync(`netstat -ano | findstr :${port}`, { encoding: "utf8" });
      const lines = result.trim().split("\n");
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid)) {
          try {
            execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
          } catch {
            // Process may already be dead
          }
        }
      }
    } catch {
      // No process on port
    }
  } else {
    try {
      // lsof -ti:PORT outputs PIDs using that port; kill them if any exist
      const pids = execSync(`lsof -ti:${port} 2>/dev/null || true`, { encoding: "utf8" }).trim();
      if (pids) {
        execSync(`kill -9 ${pids}`, { stdio: "ignore" });
      }
    } catch {
      // No process on port or already dead
    }
  }
}

function spawnPnpm(args, extraEnv = {}) {
  const isWindows = process.platform === "win32";
  const child = spawn("pnpm", args, {
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
    shell: isWindows,
    detached: !isWindows,
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

// Kill any existing processes on our ports
killPort(BACKEND_PORT);
killPort(FRONTEND_PORT);

console.log(
  `Starting: backend=${backendArg} (${serverPkg}) on :${BACKEND_PORT}, frontend=${frontendArg} (${webPkg}) on :${FRONTEND_PORT}`,
);

// Start server
spawnPnpm(["--filter", serverPkg, "dev"], { PORT: String(BACKEND_PORT) });

// Start web frontend
spawnPnpm(["--filter", webPkg, "dev"], { BACKEND_PORT: String(BACKEND_PORT) });

for (const child of children) {
  child.on("exit", (code) => {
    if (code && code !== 0) shutdown(code);
  });
}
