import { build } from "vite";

for (const target of ["main", "preload", "storage-worker", "renderer"]) {
  await build({ configFile: `apps/desktop/vite.${target}.config.ts` });
}
