import type { AutomationInstance, Run, WorkspaceSnapshot } from "@clawler/contracts";
import { useI18n } from "@clawler/i18n";
import { Badge, Button, Panel } from "@clawler/ui";
import { ArrowRight, Box, Play, Plus, X } from "lucide-react";
import { useState } from "react";
import { statusKeys, statusTones } from "../../shared/presentation";

function InstanceRunState({ run }: { run: Run | undefined }) {
  const { t, formatDate } = useI18n();
  if (!run) return <span className="instance-never-run">{t("neverRun")}</span>;
  return (
    <div className="instance-run-state">
      <Badge tone={statusTones[run.status]}>{t(statusKeys[run.status])}</Badge>
      <small className="instance-run-time">{formatDate(run.startedAt)}</small>
    </div>
  );
}

export function InstancesPage({
  workspace,
  disabled,
  onCreate,
  onOpen,
  onRun,
}: {
  workspace: WorkspaceSnapshot;
  disabled: boolean;
  onCreate(name: string): void;
  onOpen(instance: AutomationInstance): void;
  onRun(instance: AutomationInstance): void;
}) {
  const { t } = useI18n();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  return (
    <div className="instances-page">
      <header className="page-heading instances-heading">
        <div>
          <div className="eyebrow">{t("instancesEyebrow")}</div>
          <h1>{t("instancesTitle")}</h1>
          <p>{t("instancesDescription")}</p>
        </div>
        <Button tone="primary" onClick={() => setCreating(true)}>
          <Plus size={14} />
          {t("newInstance")}
        </Button>
      </header>

      {creating && (
        <form
          className="instance-create-bar"
          onSubmit={(event) => {
            event.preventDefault();
            onCreate(name);
            setName("");
            setCreating(false);
          }}
        >
          <Box size={17} />
          <label htmlFor="instance-name">{t("instanceName")}</label>
          <input
            id="instance-name"
            value={name}
            maxLength={64}
            required
            placeholder={t("instancePlaceholder")}
            onChange={(event) => setName(event.target.value)}
          />
          <Button type="submit" tone="primary" disabled={disabled || !name.trim()}>
            {t("createInstance")}
          </Button>
          <Button tone="ghost" aria-label={t("close")} onClick={() => setCreating(false)}>
            <X size={14} />
          </Button>
        </form>
      )}

      <div className="instance-list-meta">
        <strong>{t("allInstances")}</strong>
        <span>{t("instanceCount", { count: workspace.instances.length })}</span>
      </div>
      <Panel className="instance-list">
        <div className="instance-list-head">
          <span>{t("instanceColumn")}</span>
          <span>{t("instanceProfile")}</span>
          <span>{t("instanceLastRun")}</span>
          <span>{t("instanceStatus")}</span>
          <span className="sr-only">{t("instanceActions")}</span>
        </div>
        {workspace.instances.map((instance, index) => {
          const profile = workspace.profiles.find((entry) => entry.id === instance.profileId);
          const latestRun = workspace.runs.find((run) => run.instanceId === instance.id);
          let instanceTone: "success" | "neutral" = "neutral";
          let instanceStatusKey: "enabled" | "paused" = "paused";
          if (instance.enabled) {
            instanceTone = "success";
            instanceStatusKey = "enabled";
          }
          return (
            <div className="instance-row" key={instance.id}>
              <button
                type="button"
                className="instance-main"
                onClick={() => onOpen(instance)}
                disabled={disabled}
              >
                <span className="instance-index">{String(index + 1).padStart(2, "0")}</span>
                <span>
                  <strong>{instance.name}</strong>
                  <small className="instance-script-name">{t("scriptTitle")}</small>
                </span>
              </button>
              <span className="instance-profile-name">{profile?.name ?? t("errorNotFound")}</span>
              <InstanceRunState run={latestRun} />
              <Badge tone={instanceTone}>{t(instanceStatusKey)}</Badge>
              <div className="instance-row-actions">
                <Button
                  tone="ghost"
                  disabled={disabled || !instance.enabled}
                  aria-label={t("runInstance")}
                  onClick={() => onRun(instance)}
                >
                  <Play size={13} />
                </Button>
                <Button tone="ghost" onClick={() => onOpen(instance)} disabled={disabled}>
                  {t("openInstance")}
                  <ArrowRight size={13} />
                </Button>
              </div>
            </div>
          );
        })}
      </Panel>
    </div>
  );
}
