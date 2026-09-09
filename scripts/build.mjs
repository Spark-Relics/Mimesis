import { build } from "vite";

for (const target of ["main", "preload", "renderer"]) {
  await build({ configFile: `apps/desktop/vite.${target}.config.ts` });
}
