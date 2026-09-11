import { build, createServer } from "vite";
import { launchElectron } from "./process.mjs";

const server = await createServer({ configFile: "apps/desktop/vite.renderer.config.ts" });
await server.listen();
server.printUrls();
const rendererUrl = server.resolvedUrls?.local[0];
if (!rendererUrl) throw new Error("No renderer development URL");

let child;
let restartTimer;
let closing = false;
const ready = new Set();
const watchers = [];

function startElectron() {
  if (closing) return;
  if (child) child.kill();
  console.log("[desktop] Starting Electron...");
  child = launchElectron({ CLAWLER_RENDERER_URL: rendererUrl });
  child.on("error", (error) => console.error("[desktop] Failed to start Electron", error));
  child.on("exit", (code, signal) => {
    if (closing) return;
    console.log(`[desktop] Electron exited (code: ${String(code)}, signal: ${String(signal)})`);
  });
}

function restart() {
  if (closing || ready.size !== 3) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    startElectron();
  }, 150);
}

for (const target of ["main", "preload", "storage-worker"]) {
  const watcher = await build({
    configFile: `apps/desktop/vite.${target}.config.ts`,
    build: { watch: {} },
    plugins: [
      {
        name: `clawler-${target}-ready`,
        closeBundle() {
          ready.add(target);
          restart();
        },
      },
    ],
  });
  watchers.push(watcher);
}

async function close() {
  if (closing) return;
  closing = true;
  clearTimeout(restartTimer);
  child?.kill();
  await Promise.all(watchers.map((watcher) => watcher.close()));
  await server.close();
}
process.on("SIGINT", () => {
  void close();
});
process.on("SIGTERM", () => {
  void close();
});
