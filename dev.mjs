import { spawn } from "node:child_process";
import fs from "node:fs";

// Usage: pnpm dev [backend] [frontend]
// Defaults: backend=basic, frontend=basic

const DEFAULT_BACKEND = "basic";
const DEFAULT_FRONTEND = "basic";

const backendArg = process.argv[2] ?? DEFAULT_BACKEND;
const frontendArg = process.argv[3] ?? DEFAULT_FRONTEND;

const children = [];

function spawnPnpm(args, extraEnv = {}) {
  const child = spawn("pnpm", args, {
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
    shell: process.platform === "win32",
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
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

console.log(`Starting: backend=${backendArg} (${serverPkg}), frontend=${frontendArg} (${webPkg})`);

// Start server (port 3001)
spawnPnpm(["--filter", serverPkg, "dev"], { PORT: "3001" });

// Start web frontend (port 3000)
spawnPnpm(["--filter", webPkg, "dev"]);

for (const child of children) {
  child.on("exit", (code) => {
    if (code && code !== 0) shutdown(code);
  });
}
