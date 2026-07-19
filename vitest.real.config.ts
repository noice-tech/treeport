import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.real.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
