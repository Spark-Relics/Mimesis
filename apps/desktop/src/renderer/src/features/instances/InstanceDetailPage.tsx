import type { AutomationInstance, InstanceUpdate, WorkspaceSnapshot } from "@clawler/contracts";
import { useI18n } from "@clawler/i18n";
import { Badge, Button, cn, Panel } from "@clawler/ui";
import {
  ArrowLeft,
  Braces,
  Check,
  CircleDot,
  FileClock,
  ListTree,
  Play,
  Save,
  Settings2,
  Square,
} from "lucide-react";
import { useState } from "react";
import { RunsPage } from "../runs/RunsPage";
import { ScriptStudio } from "../studio/ScriptStudio";

const detailTabs = [
  { id: "tasks", key: "instanceTasks", icon: ListTree },
  { id: "script", key: "instanceScriptTab", icon: Braces },
  { id: "config", key: "instanceConfig", icon: Settings2 },
  { id: "runs", key: "instanceRuns", icon: FileClock },
] as const;
type DetailTab = (typeof detailTabs)[number]["id"];

function InstanceConfiguration({
  instance,
  workspace,
  disabled,
  onSave,
}: {
  instance: AutomationInstance;
  workspace: WorkspaceSnapshot;
  disabled: boolean;
  onSave(input: InstanceUpdate): void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(instance.name);
  const [targetUrl, setTargetUrl] = useState(instance.targetUrl);
  const [profileId, setProfileId] = useState(instance.profileId);
  const [enabled, setEnabled] = useState(instance.enabled);
  return (
    <Panel className="instance-config-panel">
      <div className="instance-section-heading">
        <div>
          <strong>{t("configurationTitle")}</strong>
          <p>{t("configurationDescription")}</p>
        </div>
      </div>
      <form
        className="instance-config-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ name, targetUrl, profileId, enabled });
        }}
      >
        <label htmlFor="config-instance-name">{t("instanceName")}</label>
        <input
          id="config-instance-name"
          value={name}
          maxLength={64}
          required
          disabled={disabled}
          onChange={(event) => setName(event.target.value)}
        />
        <label htmlFor="config-target-url">{t("targetUrl")}</label>
        <input
          id="config-target-url"
          value={targetUrl}
          required
          disabled={disabled}
          placeholder={t("targetPlaceholder")}
          onChange={(event) => setTargetUrl(event.target.value)}
        />
        <label htmlFor="config-profile">{t("instanceProfile")}</label>
        <select
          id="config-profile"
          value={profileId}
          disabled={disabled}
          onChange={(event) => setProfileId(event.target.value)}
        >
          {workspace.profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
        <label className="instance-enable-row" htmlFor="config-enabled">
          <span>
            <strong>{t("enableInstance")}</strong>
            <small className="instance-enable-description">{t("enableInstanceDescription")}</small>
          </span>
          <input
            id="config-enabled"
            type="checkbox"
            checked={enabled}
            disabled={disabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
        </label>
        <div className="instance-config-actions">
          <Button type="submit" tone="primary" disabled={disabled || !name.trim()}>
            <Save size={13} />
            {t("saveConfiguration")}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function InstanceTasks({ instance }: { instance: AutomationInstance }) {
  const { t } = useI18n();
  return (
    <Panel className="task-flow">
      <div className="instance-section-heading">
        <div>
          <strong>{t("taskFlowTitle")}</strong>
          <p>{t("taskFlowDescription")}</p>
        </div>
        <Badge>{t("taskCount", { count: 2 })}</Badge>
      </div>
      <div className="task-flow-row">
        <span className="task-sequence">{String(1).padStart(2, "0")}</span>
        <span className="task-icon">
          <CircleDot size={16} />
        </span>
        <span className="task-copy">
          <strong>{t("stepNavigate")}</strong>
          <small className="task-description">{t("taskNavigateDescription")}</small>
        </span>
        <code>{instance.targetUrl}</code>
        <Badge tone="success">
          <Check size={10} />
          {t("configured")}
        </Badge>
      </div>
      <div className="task-flow-row">
        <span className="task-sequence">{String(2).padStart(2, "0")}</span>
        <span className="task-icon">
          <Braces size={16} />
        </span>
        <span className="task-copy">
          <strong>{t("stepInspect")}</strong>
          <small className="task-description">{t("taskInspectDescription")}</small>
        </span>
        <code>{t("structuredOutput")}</code>
        <Badge tone="success">
          <Check size={10} />
          {t("configured")}
        </Badge>
      </div>
    </Panel>
  );
}

export function InstanceDetailPage({
  instance,
  workspace,
  pending,
  onBack,
  onSaveDraft,
  onUpdate,
  onRun,
  onCancel,
  onNavigate,
  onSelectProfile,
  onCopyError,
}: {
  instance: AutomationInstance;
  workspace: WorkspaceSnapshot;
  pending: boolean;
  onBack(): void;
  onSaveDraft(source: string): Promise<void>;
  onUpdate(input: InstanceUpdate): void;
  onRun(): void;
  onCancel(id: string): void;
  onNavigate(url: string): void;
  onSelectProfile(id: string): void;
  onCopyError(): void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<DetailTab>("tasks");
  const instanceRuns = workspace.runs.filter((run) => run.instanceId === instance.id);
  const activeRun = instanceRuns.find((run) => run.status === "running");
  let stateKey: "enabled" | "paused" = "paused";
  if (instance.enabled) stateKey = "enabled";
  return (
    <div className="instance-detail">
      <header className="instance-detail-header">
        <Button tone="ghost" aria-label={t("backToInstances")} onClick={onBack}>
          <ArrowLeft size={16} />
        </Button>
        <div className="instance-detail-title">
          <span className="instance-detail-mark">
            <ListTree size={20} />
          </span>
          <div>
            <div>
              <h1>{instance.name}</h1>
              <Badge>{t(stateKey)}</Badge>
            </div>
            <p>{t("instanceDetailDescription", { script: t("scriptTitle") })}</p>
          </div>
        </div>
        <div className="instance-detail-actions">
          {activeRun && (
            <Button tone="danger" disabled={pending} onClick={() => onCancel(activeRun.id)}>
              <Square size={12} />
              {t("cancel")}
            </Button>
          )}
          {!activeRun && (
            <Button tone="primary" disabled={pending || !instance.enabled} onClick={onRun}>
              <Play size={13} />
              {t("runInstance")}
            </Button>
          )}
        </div>
      </header>
      <nav className="instance-tabs" aria-label={t("instanceSections")}>
        {detailTabs.map((entry) => (
          <button
            type="button"
            key={entry.id}
            className={cn("instance-tab", tab === entry.id && "is-active")}
            onClick={() => setTab(entry.id)}
          >
            <entry.icon size={14} />
            {t(entry.key)}
          </button>
        ))}
      </nav>
      <div className="instance-detail-content">
        {tab === "tasks" && <InstanceTasks instance={instance} />}
        {tab === "script" && (
          <ScriptStudio
            workspace={workspace}
            pending={pending}
            instanceId={instance.id}
            initialUrl={instance.targetUrl}
            onSave={onSaveDraft}
            onRun={onRun}
            onCancel={onCancel}
            onNavigate={onNavigate}
            onSelectProfile={onSelectProfile}
            onCopyError={onCopyError}
          />
        )}
        {tab === "config" && (
          <InstanceConfiguration
            key={instance.updatedAt}
            instance={instance}
            workspace={workspace}
            disabled={pending || Boolean(activeRun)}
            onSave={onUpdate}
          />
        )}
        {tab === "runs" && <RunsPage runs={instanceRuns} onCopyError={onCopyError} />}
      </div>
    </div>
  );
}
