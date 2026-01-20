import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import viteTsConfigPaths from "vite-tsconfig-paths";
import tailwindcss from "@tailwindcss/vite";

const backendPort = process.env.BACKEND_PORT ?? "3001";

const config = defineConfig({
  plugins: [
    viteTsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tailwindcss(),
    viteReact(),
  ],
  server: {
    proxy: {
      "/agents": {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true,
        // Configure proxy for SSE (Server-Sent Events) streaming
        configure: (proxy, _options) => {
          // Disable buffering for SSE responses
          proxy.on("proxyRes", (_proxyRes, req, res) => {
            // Check if this is an SSE request (has live=sse in query)
            if (req.url?.includes("live=sse")) {
              // Set headers to disable buffering
              res.setHeader("Cache-Control", "no-cache");
              res.setHeader("X-Accel-Buffering", "no");
              // Ensure chunked transfer encoding for streaming
              res.setHeader("Transfer-Encoding", "chunked");
            }
          });
        },
      },
    },
  },
});

export default config;
