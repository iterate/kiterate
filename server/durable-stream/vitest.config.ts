import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    includeSource: ["src/**/*.ts"],
    testTimeout: 20_000,
  },
});
