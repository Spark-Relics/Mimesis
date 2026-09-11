import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "tests/unit/**/*.test.ts", "tests/unit/**/*.test.mjs"],
    environment: "node",
    coverage: { include: ["packages/**/src/**/*.ts"] },
  },
});
