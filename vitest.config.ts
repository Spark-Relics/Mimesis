import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "tests/unit/**/*.test.ts"],
    environment: "node",
    coverage: { include: ["packages/**/src/**/*.ts"] },
  },
});
