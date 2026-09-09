import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { IPC, type RpcResult, requestSchema, toErrorCode } from "@clawler/contracts";
import {
  FileGatewayRepository,
  GatewayQueue,
  GatewayServer,
  gatewayConfigFromEnv,
} from "@clawler/gateway";
import { JsonWorkspaceRepository } from "@clawler/storage";
import { app, BrowserWindow, ipcMain, protocol, session } from "electron";
import { assertTrustedSender, resolveAssetPath } from "./security";
import { WorkspaceService } from "./workspace-service";

protocol.registerSchemesAsPrivileged([
  { scheme: "clawler-app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: "clawler-demo", privileges: { standard: true, secure: true } },
]);

if (process.env.CLAWLER_DATA_DIR) app.setPath("userData", process.env.CLAWLER_DATA_DIR);
const ownsWorkspace = app.requestSingleInstanceLock();
if (!ownsWorkspace) app.quit();

const devUrl = process.env.CLAWLER_RENDERER_URL;
const mimeTypes: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
let mainWindow: BrowserWindow | undefined;
let service: WorkspaceService | undefined;
let gatewayQueue: GatewayQueue | undefined;
let gatewayServer: GatewayServer | undefined;
let shuttingDown = false;
let shutdownComplete = false;

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1512,
    height: 1000,
    minWidth: 1080,
    minHeight: 760,
    show: false,
    backgroundColor: "#f5f5f2",
    title: "Mimesis",
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = window;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  const repository = new JsonWorkspaceRepository(join(app.getPath("userData"), "workspace.json"));
  service = await WorkspaceService.create(window, repository);
  const gatewayConfig = gatewayConfigFromEnv(process.env);
  if (gatewayConfig) {
    gatewayQueue = await GatewayQueue.open(
      new FileGatewayRepository(join(app.getPath("userData"), "runtime")),
      service,
    );
    gatewayServer = await GatewayServer.listen(
      gatewayConfig,
      gatewayQueue,
      () => service?.listInstances() ?? [],
    );
    gatewayQueue.start();
    console.info(`Gateway listening at http://127.0.0.1:${gatewayServer.port}`);
  }
  ipcMain.removeHandler(IPC.request);
  ipcMain.handle(IPC.request, async (event, payload: unknown): Promise<RpcResult<unknown>> => {
    try {
      assertTrustedSender(event, window.webContents.id, devUrl);
      const request = requestSchema.parse(payload);
      return { ok: true, value: await service?.dispatch(request) };
    } catch (error) {
      return { ok: false, error: toErrorCode(error) };
    }
  });
  const shouldShow = process.env.CLAWLER_TEST !== "1";
  window.once("ready-to-show", () => {
    if (shouldShow) window.show();
  });
  window.on("closed", () => {
    service?.dispose();
    service = undefined;
    mainWindow = undefined;
  });
  window.on("close", (event) => {
    if (gatewayQueue && !shutdownComplete) {
      event.preventDefault();
      app.quit();
    }
  });
  if (devUrl) await window.loadURL(devUrl);
  else await window.loadURL("clawler-app://ui/index.html");
  if (shouldShow && !window.isVisible()) window.show();
}

void app
  .whenReady()
  .then(async () => {
    if (!ownsWorkspace) return;
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    protocol.handle("clawler-app", async (request) => {
      try {
        const url = new URL(request.url);
        if (url.hostname !== "ui") return new Response(null, { status: 403 });
        const file = resolveAssetPath(join(__dirname, "../renderer"), url.pathname);
        const content = await readFile(file);
        return new Response(content, {
          headers: {
            "Content-Type": `${mimeTypes[extname(file)] ?? "application/octet-stream"}; charset=utf-8`,
            "Content-Security-Policy":
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-src 'none'",
          },
        });
      } catch {
        return new Response(null, { status: 404 });
      }
    });
    await createWindow();
    app.on("activate", () => {
      if (!mainWindow) void createWindow();
    });
  })
  .catch((error: unknown) => {
    console.error("Application startup failed", error);
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (shutdownComplete || !ownsWorkspace) return;
  event.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  void (async () => {
    try {
      await gatewayQueue?.close();
      await gatewayServer?.close();
      await service?.flush();
    } catch (error) {
      console.error("Application shutdown failed", error);
    } finally {
      shutdownComplete = true;
      app.quit();
    }
  })();
});
