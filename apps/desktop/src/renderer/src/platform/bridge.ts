import { AppError, type DesktopBridge, type WorkspaceSnapshot } from "@clawler/contracts";

/** Web preview is explicitly non-executing; it never pretends a task succeeded. */
function createPreviewBridge(): DesktopBridge {
  const profile = {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Default",
    createdAt: new Date().toISOString(),
  };
  const snapshot: WorkspaceSnapshot = {
    instances: [
      {
        id: "00000000-0000-4000-8000-000000000002",
        name: "Page inspector",
        scriptId: "page-inspector",
        profileId: profile.id,
        targetUrl: "clawler-demo://catalog/",
        enabled: true,
        createdAt: profile.createdAt,
        updatedAt: profile.createdAt,
      },
    ],
    profiles: [profile],
    selectedProfileId: profile.id,
    runs: [],

    scripts: [
      {
        id: "page-inspector",
        version: "1.0.0",
        sdkVersion: 1,
        ai: "disabled",
        implementation: "bundled",
      },
    ],
  };
  function desktopRequired(): never {
    throw new AppError("DESKTOP_REQUIRED");
  }
  return {
    getStorageLocation: async () => desktopRequired(),
    chooseStorageDirectory: async () => desktopRequired(),
    openStorageDirectory: async () => desktopRequired(),
    scheduleStorageDirectory: async () => desktopRequired(),
    cancelStorageDirectory: async () => desktopRequired(),
    scheduleStorageBackup: async () => desktopRequired(),
    cancelStorageBackup: async () => desktopRequired(),
    getWorkspace: async () => structuredClone(snapshot),
    createProfile: async () => desktopRequired(),
    selectProfile: async () => desktopRequired(),
    createInstance: async () => desktopRequired(),
    updateInstance: async () => desktopRequired(),
    saveWorkflow: async () => desktopRequired(),
    navigate: async () => desktopRequired(),
    startRecording: async () => desktopRequired(),
    stopRecording: async () => desktopRequired(),
    controlWindow: async () => undefined,
    startRun: async () => desktopRequired(),
    cancelRun: async () => desktopRequired(),
    setBrowserBounds: async () => undefined,
    onRunChanged: () => () => undefined,
  };
}

export const isDesktop = Boolean(window.clawler);
export const bridge = window.clawler ?? createPreviewBridge();
