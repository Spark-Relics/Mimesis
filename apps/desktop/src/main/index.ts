import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { IPC, type RpcResult, requestSchema, toErrorCode } from "@clawler/contracts";
import {
  GatewayQueue,
  GatewayServer,
  gatewayConfigFromEnv,
  SqliteGatewayRepository,
} from "@clawler/gateway";
import { enUS, zhCN } from "@clawler/i18n/resources";
import { StorageLocationManager } from "@clawler/storage/location";
import { RuntimeStore } from "@clawler/storage/runtime";
import { app, BrowserWindow, dialog, ipcMain, protocol, session, shell } from "electron";
import { assertTrustedSender, resolveAssetPath } from "./security";
import { WorkspaceService } from "./workspace-service";

protocol.registerSchemesAsPrivileged([
  { scheme: "clawler-app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: "clawler-demo", privileges: { standard: true, secure: true } },
]);

const defaultDataRoot = process.env.CLAWLER_DEFAULT_DATA_DIR ?? app.getPath("userData");
let configurationRoot = join(app.getPath("appData"), "MimesisLauncher");
if (process.env.CLAWLER_DATA_DIR) configurationRoot = `${process.env.CLAWLER_DATA_DIR}.launcher`;
if (process.env.CLAWLER_CONFIG_DIR) configurationRoot = process.env.CLAWLER_CONFIG_DIR;
let location: StorageLocationManager | undefined;
let startupError: unknown;
let ownsWorkspace = false;
try {
  mkdirSync(configurationRoot, { recursive: true });
  // Keep the application lock stable when the data directory changes.
  app.setPath("userData", configurationRoot);
  ownsWorkspace = app.requestSingleInstanceLock();
  if (ownsWorkspace) {
    location = new StorageLocationManager(
      configurationRoot,
      defaultDataRoot,
      process.env.CLAWLER_DATA_DIR,
    );
    app.setPath("userData", location.current);
    app.setPath("sessionData", location.current);
    app.setAppLogsPath(join(location.current, "logs"));
  }
} catch (error) {
  startupError = error;
}
if (!ownsWorkspace && !startupError) app.quit();

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
let store: RuntimeStore | undefined;
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
  store = await RuntimeStore.open(
    app.getPath("userData"),
    join(__dirname, "../storage-worker/index.cjs"),
  );
  service = await WorkspaceService.create(window, store);
  const gatewayConfig = gatewayConfigFromEnv(process.env);
  if (gatewayConfig) {
    gatewayQueue = await GatewayQueue.open(
      new SqliteGatewayRepository(join(app.getPath("userData"), "runtime"), store),
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
      if (shuttingDown) return { ok: false, error: "BUSY" };
      const request = requestSchema.parse(payload);
      if (location) {
        switch (request.method) {
          case "storage.get":
            return { ok: true, value: location.info() };
          case "storage.schedule":
            return { ok: true, value: await location.schedule(request.path) };
          case "storage.cancel":
            return { ok: true, value: await location.cancel() };
          case "storage.choose": {
            const selected = await dialog.showOpenDialog(window, {
              properties: ["openDirectory", "createDirectory"],
              defaultPath: location.current,
            });
            let path: string | null = null;
            if (!selected.canceled) path = selected.filePaths[0] ?? null;
            return { ok: true, value: path };
          }
          case "storage.open": {
            const failure = await shell.openPath(location.current);
            if (failure) return { ok: false, error: "STORAGE_FAILED" };
            return { ok: true, value: null };
          }
        }
      }
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
    if (!shutdownComplete) {
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
    if (startupError) throw startupError;
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
  .catch(async (error: unknown) => {
    console.error("Application startup failed", error);
    if (process.env.CLAWLER_TEST !== "1") {
      let messages: Record<keyof typeof zhCN, string> = zhCN;
      if (app.getLocale().startsWith("en")) messages = enUS;
      const buttons = [messages.close];
      if (StorageLocationManager.hasPending(configurationRoot)) {
        buttons[0] = messages.storageKeepPending;
        buttons.push(messages.storageCancel);
      }
      const response = await dialog.showMessageBox({
        type: "error",
        title: messages.storageStartupTitle,
        message: messages.storageStartupHint,
        detail: `${toErrorCode(error)}\n${configurationRoot}`,
        buttons,
        cancelId: 0,
      });
      if (response.response === 1) {
        try {
          StorageLocationManager.cancelPending(configurationRoot);
        } catch (failure) {
          console.error("Cannot cancel directory change", failure);
        }
      }
    }
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => location?.close());

app.on("before-quit", (event) => {
  if (shutdownComplete || !ownsWorkspace) return;
  event.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  void (async () => {
    try {
      await gatewayQueue?.close();
      await gatewayServer?.close();
      await service?.shutdown();
      await location?.flush();
    } catch (error) {
      console.error("Application shutdown failed", error);
    } finally {
      await store
        ?.close()
        .catch((error: unknown) => console.error("Storage shutdown failed", error));
      shutdownComplete = true;
      app.quit();
    }
  })();
});
