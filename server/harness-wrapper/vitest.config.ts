import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.e2e.test.ts"],
    testTimeout: 120_000, // Long timeout for e2e tests with PI agent
    // Run tests sequentially since e2e tests share the same server port
    fileParallelism: false,
  },
});
