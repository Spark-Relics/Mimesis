import {
  AppError,
  automationInstanceSchema,
  type DesktopBridge,
  type DesktopRequest,
  errorCodeSchema,
  IPC,
  instanceUpdateSchema,
  profileSchema,
  recordingSchema,
  runSchema,
  storageLocationSchema,
  workspaceSchema,
  z,
} from "@clawler/contracts";
import { contextBridge, ipcRenderer } from "electron";

const envelopeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), error: errorCodeSchema }),
]);

async function request(input: DesktopRequest): Promise<unknown> {
  const response = envelopeSchema.parse(await ipcRenderer.invoke(IPC.request, input));
  if (!response.ok) throw new AppError(response.error);
  return response.value;
}

const bridge: DesktopBridge = {
  getStorageLocation: async () =>
    storageLocationSchema.parse(await request({ method: "storage.get" })),
  chooseStorageDirectory: async () =>
    z
      .string()
      .nullable()
      .parse(await request({ method: "storage.choose" })),
  openStorageDirectory: async () => {
    await request({ method: "storage.open" });
  },
  scheduleStorageDirectory: async (path) =>
    storageLocationSchema.parse(await request({ method: "storage.schedule", path })),
  cancelStorageDirectory: async () =>
    storageLocationSchema.parse(await request({ method: "storage.cancel" })),
  scheduleStorageBackup: async (kind, path) =>
    storageLocationSchema.parse(await request({ method: "storage.backup.schedule", kind, path })),
  cancelStorageBackup: async () =>
    storageLocationSchema.parse(await request({ method: "storage.backup.cancel" })),
  getWorkspace: async () => workspaceSchema.parse(await request({ method: "workspace.get" })),
  createProfile: async (name) =>
    profileSchema.parse(await request({ method: "profiles.create", name })),
  selectProfile: async (id) => {
    await request({ method: "profiles.select", id });
  },
  createInstance: async (name) =>
    automationInstanceSchema.parse(await request({ method: "instances.create", name })),
  updateInstance: async (id, input) =>
    automationInstanceSchema.parse(
      await request({ method: "instances.update", id, input: instanceUpdateSchema.parse(input) }),
    ),
  saveWorkflow: async (instanceId, workflow, input) =>
    automationInstanceSchema.parse(
      await request({ method: "workflow.save", instanceId, workflow, input }),
    ),
  setBrowserBounds: async (bounds) => {
    await request({ method: "browser.bounds", bounds });
  },
  navigate: async (url) => {
    await request({ method: "browser.navigate", url });
  },
  startRecording: async () => {
    await request({ method: "recording.start" });
  },
  stopRecording: async () => recordingSchema.parse(await request({ method: "recording.stop" })),
  controlWindow: async (action) => {
    await request({ method: "window.control", action });
  },
  startRun: async (instanceId, parameters) =>
    runSchema.parse(await request({ method: "runs.start", instanceId, parameters })),
  cancelRun: async (id) => {
    await request({ method: "runs.cancel", id });
  },
  onRunChanged(listener) {
    const handle = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      const result = runSchema.safeParse(payload);
      if (result.success) listener(result.data);
    };
    ipcRenderer.on(IPC.runChanged, handle);
    return () => {
      ipcRenderer.removeListener(IPC.runChanged, handle);
    };
  },
};

contextBridge.exposeInMainWorld("clawler", bridge);
