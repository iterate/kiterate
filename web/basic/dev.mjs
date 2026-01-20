import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendName = process.argv[2];

const children = [];

function spawnProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  children.push(child);
  child.on("exit", (code) => {
    if (code && code !== 0) shutdown(code);
  });
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

// Always start Vite via doppler
spawnProcess("pnpm", ["exec", "doppler", "run", "--", "vite", "dev", "--port", "3000"], {
  cwd: __dirname,
});

// If a backend name is provided, start it from server/[name]
if (backendName) {
  const serverPath = resolve(__dirname, "../../server", backendName);
  spawnProcess("pnpm", ["dev"], {
    cwd: serverPath,
    env: { ...process.env, PORT: "3001" },
  });
}
