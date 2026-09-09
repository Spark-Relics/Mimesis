import type {
  AutomationInstance,
  InstanceUpdate,
  WindowControl,
  WorkspaceSnapshot,
} from "@clawler/contracts";
import { useI18n } from "@clawler/i18n";
import { Button, cn, EmptyState } from "@clawler/ui";
import { Boxes, Command, FolderLock, History, Minus, Settings2, Square, X } from "lucide-react";
import { useState } from "react";
import { InstanceDetailPage } from "../features/instances/InstanceDetailPage";
import { InstancesPage } from "../features/instances/InstancesPage";
import { ProfilesPage } from "../features/profiles/ProfilesPage";
import { RunsPage } from "../features/runs/RunsPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { bridge, isDesktop } from "../platform/bridge";
import { useWorkspace } from "./use-workspace";

const navigation = [
  { id: "instances", key: "navInstances", icon: Boxes },
  { id: "profiles", key: "navProfiles", icon: FolderLock },
  { id: "runs", key: "navRuns", icon: History },
  { id: "settings", key: "navSettings", icon: Settings2 },
] as const;
type View = (typeof navigation)[number]["id"];
type Controller = ReturnType<typeof useWorkspace>;

function WorkspaceContent({
  workspace,
  controller,
  view,
  selectedInstanceId,
  onOpenInstance,
  onBackToInstances,
}: {
  workspace: WorkspaceSnapshot;
  controller: Controller;
  view: View;
  selectedInstanceId: string | undefined;
  onOpenInstance(id: string): void;
  onBackToInstances(): void;
}) {
  const { action, refresh, setNotice, pending, acceptRun } = controller;
  const disabled = pending || workspace.runs.some((run) => run.status === "running");
  const copyError = () => setNotice("errorInternal");
  function selectProfile(id: string) {
    void action(async () => {
      await bridge.selectProfile(id);
      await refresh();
    });
  }
  function runInstance(instance: AutomationInstance): void {
    void action(async () => {
      acceptRun(await bridge.startRun(instance.id));
    });
  }
  if (view === "profiles")
    return (
      <ProfilesPage
        workspace={workspace}
        disabled={disabled}
        onSelect={selectProfile}
        onCreate={(name) => {
          void action(async () => {
            await bridge.createProfile(name);
            await refresh();
            setNotice("profileCreated");
          });
        }}
      />
    );
  if (view === "runs") return <RunsPage runs={workspace.runs} onCopyError={copyError} />;
  if (view === "settings") return <SettingsPage />;
  const selectedInstance = workspace.instances.find((entry) => entry.id === selectedInstanceId);
  if (selectedInstance)
    return (
      <InstanceDetailPage
        instance={selectedInstance}
        workspace={workspace}
        pending={pending}
        onBack={onBackToInstances}
        onRefresh={refresh}
        onAcceptRun={acceptRun}
        onRecordingChange={controller.setRecording}
        onUpdate={(input: InstanceUpdate) => {
          void action(async () => {
            await bridge.updateInstance(selectedInstance.id, input);
            if (workspace.selectedProfileId !== input.profileId)
              await bridge.selectProfile(input.profileId);
            await refresh();
            setNotice("configurationSaved");
          });
        }}
        onRun={() => runInstance(selectedInstance)}
        onCancel={(id) => {
          void action(async () => {
            await bridge.cancelRun(id);
          });
        }}
        onNavigate={(url) => {
          void action(async () => {
            await bridge.navigate(url);
          });
        }}
        onSelectProfile={selectProfile}
        onCopyError={copyError}
      />
    );
  return (
    <InstancesPage
      workspace={workspace}
      disabled={disabled}
      onCreate={(name) => {
        void action(async () => {
          const instance = await bridge.createInstance(name);
          await refresh();
          setNotice("instanceCreated");
          onOpenInstance(instance.id);
        });
      }}
      onOpen={(instance) => {
        void action(async () => {
          if (workspace.selectedProfileId !== instance.profileId) {
            await bridge.selectProfile(instance.profileId);
            await refresh();
          }
          onOpenInstance(instance.id);
        });
      }}
      onRun={runInstance}
    />
  );
}

export function App() {
  const { t } = useI18n();
  const controller = useWorkspace();
  const [view, setView] = useState<View>("instances");
  const [selectedInstanceId, setSelectedInstanceId] = useState<string>();
  let runtimeKey: "localRuntime" | "desktopPreview" = "desktopPreview";
  if (isDesktop) runtimeKey = "localRuntime";

  function controlWindow(action: WindowControl): void {
    void bridge.controlWindow(action).catch(() => controller.setNotice("errorInternal"));
  }

  function navigate(viewId: View): void {
    setSelectedInstanceId(undefined);
    setView(viewId);
  }

  return (
    <div className="app-shell enterprise-shell">
      <header className="workspace-topnav">
        <div className="brand">
          <div className="brand-mark">
            <Command size={19} strokeWidth={1.7} />
          </div>
          <div>
            <strong>{t("appName")}</strong>
            <small>{t("gatewayLabel")}</small>
          </div>
        </div>
        <nav className="workspace-nav" aria-label={t("workspace")}>
          {navigation.map((entry) => (
            <button
              type="button"
              key={entry.id}
              className={cn("nav-item", view === entry.id && "is-active")}
              aria-current={view === entry.id && "page"}
              disabled={controller.recording}
              onClick={() => navigate(entry.id)}
            >
              <entry.icon size={18} strokeWidth={1.6} />
              <span>{t(entry.key)}</span>
            </button>
          ))}
        </nav>
        <span className="topnav-runtime">{t(runtimeKey)}</span>
      </header>
      <div className="workspace-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <span>{t("workspace")}</span>
            <span aria-hidden="true">{"/"}</span>
            <strong>
              {t(navigation.find((entry) => entry.id === view)?.key ?? "navInstances")}
            </strong>
            {selectedInstanceId && (
              <span className="breadcrumb-instance">
                {"/ "}
                {
                  controller.workspace?.instances.find(
                    (instance) => instance.id === selectedInstanceId,
                  )?.name
                }
              </span>
            )}
          </div>
          <div className="topbar-right">
            <div className="window-controls">
              <button
                type="button"
                aria-label={t("minimize")}
                onClick={() => controlWindow("minimize")}
              >
                <Minus size={14} />
              </button>
              <button
                type="button"
                aria-label={t("maximize")}
                onClick={() => controlWindow("toggle-maximize")}
              >
                <Square size={11} />
              </button>
              <button
                type="button"
                className="window-control-close"
                aria-label={t("close")}
                onClick={() => controlWindow("close")}
              >
                <X size={14} />
              </button>
            </div>
          </div>
        </header>
        <main className="main-content">
          {controller.workspace && (
            <WorkspaceContent
              workspace={controller.workspace}
              controller={controller}
              view={view}
              selectedInstanceId={selectedInstanceId}
              onOpenInstance={setSelectedInstanceId}
              onBackToInstances={() => setSelectedInstanceId(undefined)}
            />
          )}
          {!controller.workspace && !controller.error && (
            <EmptyState title={t("loading")} description={t("scriptFirst")} />
          )}
          {controller.error && (
            <div className="load-error">
              <EmptyState title={t("connectionUnavailable")} description={t(controller.error)} />
              <Button
                onClick={() => {
                  void controller.refresh();
                }}
              >
                {t("retry")}
              </Button>
            </div>
          )}
        </main>
        {controller.notice && (
          <div className="notification" role="status" aria-label={t("notification")}>
            <span>{t(controller.notice)}</span>
            <Button
              tone="ghost"
              aria-label={t("close")}
              onClick={() => controller.setNotice(undefined)}
            >
              <X size={14} />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
