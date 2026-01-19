import { spawn } from "node:child_process";

const target = process.argv[2];

const WEB_FILTER = "@iterate-com/daemon";
const BACKENDS = new Map([
  ["shiterate", "@kiterate/server-shiterate"],
  ["reference-implementation", "@kiterate/reference-implementation"],
]);

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

if (target && !BACKENDS.has(target)) {
  console.error(
    `Unknown backend "${target}". Use "shiterate" or "reference-implementation", or omit the arg.`,
  );
  process.exit(1);
}

if (target) {
  const backendFilter = BACKENDS.get(target);
  spawnPnpm(["--filter", backendFilter, "dev"], { PORT: "3001" });
}

spawnPnpm(["--filter", WEB_FILTER, "dev"]);

for (const child of children) {
  child.on("exit", (code) => {
    if (code && code !== 0) shutdown(code);
  });
}
