import { spawn } from "node:child_process";

// Usage: pnpm dev [backend] [frontend]
// Defaults: backend=basic, frontend=shiterate

const BACKENDS = new Map([
  ["basic", "@kiterate/server-basic"],
  ["basic-with-pi", "@kiterate/server-basic-with-pi"],
]);

const FRONTENDS = new Map([["shiterate", "@iterate-com/daemon"]]);

const DEFAULT_BACKEND = "basic";
const DEFAULT_FRONTEND = "shiterate";

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

if (!BACKENDS.has(backendArg)) {
  console.error(`Unknown backend "${backendArg}". Available: ${[...BACKENDS.keys()].join(", ")}`);
  process.exit(1);
}

if (!FRONTENDS.has(frontendArg)) {
  console.error(
    `Unknown frontend "${frontendArg}". Available: ${[...FRONTENDS.keys()].join(", ")}`,
  );
  process.exit(1);
}

const serverPkg = BACKENDS.get(backendArg);
const webPkg = FRONTENDS.get(frontendArg);

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
