import type { AutomationInstance, Run, WorkspaceSnapshot } from "@clawler/contracts";
import { useI18n } from "@clawler/i18n";
import { Badge, Button, Panel } from "@clawler/ui";
import { ArrowRight, Box, Monitor, Play, Plus, Search, X } from "lucide-react";
import { useState } from "react";
import emptyInstances from "../../assets/empty-instances.svg";
import { statusKeys, statusTones } from "../../shared/presentation";
import { filterInstances, type InstanceFilter, summarizeInstances } from "./overview";

const filters = [
  { id: "all", key: "filterAll" },
  { id: "enabled", key: "enabled" },
  { id: "paused", key: "paused" },
] as const;

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
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<InstanceFilter>("all");
  const summary = summarizeInstances(workspace);
  const visibleInstances = filterInstances(workspace.instances, query, filter);
  const counts = {
    all: workspace.instances.length,
    enabled: summary.enabled,
    paused: workspace.instances.length - summary.enabled,
  };
  return (
    <div className="instances-page">
      <header className="page-heading instances-heading">
        <div>
          <h1>{t("instancesTitle")}</h1>
          <p>{t("instancesDescription")}</p>
        </div>
        <Button tone="primary" disabled={disabled} onClick={() => setCreating(true)}>
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

      <Panel className="instance-list">
        <div className="instance-list-meta">
          <div>
            <strong>{t("allInstances")}</strong>
            <span>{t("instanceCount", { count: visibleInstances.length })}</span>
          </div>
          <label className="instance-search">
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t("searchInstances")}
              placeholder={t("searchInstances")}
            />
          </label>
        </div>
        <fieldset className="instance-filters">
          <legend className="sr-only">{t("filterInstances")}</legend>
          {filters.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={filter === entry.id}
              onClick={() => setFilter(entry.id)}
            >
              {t(entry.key)}
              <span>{counts[entry.id]}</span>
            </button>
          ))}
        </fieldset>
        <div className="instance-table-wrap">
          <table className="instance-table">
            <thead>
              <tr className="instance-list-head">
                <th scope="col">{t("instanceTargetColumn")}</th>
                <th scope="col">{t("instanceProfile")}</th>
                <th scope="col">{t("instanceLastRun")}</th>
                <th scope="col">{t("instanceStatus")}</th>
                <th scope="col">
                  <span className="sr-only">{t("instanceActions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleInstances.map((instance) => {
                const profile = workspace.profiles.find((entry) => entry.id === instance.profileId);
                const latestRun = summary.latest.get(instance.id);
                let instanceTone: "success" | "neutral" = "neutral";
                let instanceStatusKey: "enabled" | "paused" = "paused";
                if (instance.enabled) {
                  instanceTone = "success";
                  instanceStatusKey = "enabled";
                }
                return (
                  <tr className="instance-row" key={instance.id}>
                    <td>
                      <button
                        type="button"
                        className="instance-main"
                        onClick={() => onOpen(instance)}
                        disabled={disabled}
                      >
                        <span>
                          <strong>{instance.name}</strong>
                          <small className="instance-script-name">{instance.targetUrl}</small>
                        </span>
                      </button>
                    </td>
                    <td>
                      <span className="instance-profile-name">
                        <Monitor size={14} />
                        {profile?.name ?? t("errorNotFound")}
                      </span>
                    </td>
                    <td>
                      <InstanceRunState run={latestRun} />
                    </td>
                    <td>
                      <Badge tone={instanceTone}>{t(instanceStatusKey)}</Badge>
                    </td>
                    <td>
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
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {visibleInstances.length === 0 && (
          <div className="instance-empty" role="status">
            <img src={emptyInstances} alt="" width="128" height="88" />
            <strong>{t("noMatchingInstances")}</strong>
            <p>{t("noMatchingDescription")}</p>
            {(query || filter !== "all") && (
              <Button
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                }}
              >
                {t("clearFilters")}
              </Button>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}
