import { resolve } from "node:path";
import { defineConfig } from "vite";

export function electronConfig(target: "main" | "preload") {
  const root = resolve(import.meta.dirname, "..");
  return defineConfig({
    root,
    publicDir: false,
    build: {
      outDir: resolve(root, "dist", target),
      emptyOutDir: true,
      sourcemap: true,
      minify: false,
      target: "node24",
      lib: {
        entry: resolve(root, "src", target, "index.ts"),
        formats: ["cjs"],
        fileName: () => "index.cjs",
      },
      rolldownOptions: { external: ["electron", /^node:/], output: { codeSplitting: false } },
    },
  });
}
