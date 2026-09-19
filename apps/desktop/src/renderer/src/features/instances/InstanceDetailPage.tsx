import {
  type AutomationInstance,
  collectionWorkflowSchema,
  type InstanceUpdate,
  type Run,
  type WorkspaceSnapshot,
  workflowParametersSchema,
} from "@clawler/contracts";
import { useI18n } from "@clawler/i18n";
import { Badge, Button, cn } from "@clawler/ui";
import {
  ArrowLeft,
  Circle,
  FileClock,
  FlaskConical,
  Globe2,
  History,
  Play,
  Save,
  Settings2,
  Square,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { bridge, isDesktop } from "../../platform/bridge";
import { errorMessageKey } from "../../shared/presentation";
import { BrowserPanel } from "../browser/BrowserPanel";
import { RunsPage } from "../runs/RunsPage";
import {
  CollectionEditor,
  emptyWorkflow,
  quotesWorkflow,
  tiktokProfileWorkflow,
} from "./CollectionEditor";
import { InstanceConfiguration } from "./InstanceConfiguration";

const detailTabs = [
  { id: "browser", key: "flowBrowse", icon: Globe2 },
  { id: "config", key: "instanceConfig", icon: Settings2 },
  { id: "versions", key: "instanceVersions", icon: History },
  { id: "runs", key: "instanceRuns", icon: FileClock },
] as const;
type DetailTab = (typeof detailTabs)[number]["id"];

function versionName(version: number): string {
  return `v${version}`;
}

export function InstanceDetailPage({
  instance,
  workspace,
  pending,
  onBack,
  onRefresh,
  onAcceptRun,
  onRecordingChange,
  onUpdate,
  onClearWatermark,
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
  onRefresh(): Promise<void>;
  onAcceptRun(run: Run): void;
  onRecordingChange(recording: boolean): void;
  onUpdate(input: InstanceUpdate): void;
  onClearWatermark(): void;
  onRun(): void;
  onCancel(id: string): void;
  onNavigate(url: string): void;
  onSelectProfile(id: string): void;
  onCopyError(): void;
}) {
  const { t, formatDate } = useI18n();
  const [tab, setTab] = useState<DetailTab>("browser");
  const [url, setUrl] = useState(instance.targetUrl);
  const [workflow, setWorkflow] = useState(instance.workflow ?? structuredClone(emptyWorkflow));
  const [parameters, setParameters] = useState("{}");
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const recorderOwned = useRef(false);
  const instanceRuns = workspace.runs.filter((run) => run.instanceId === instance.id);
  const activeRun = instanceRuns.find((run) => run.status === "running");
  const instanceVersions = workspace.versions
    .filter((entry) => entry.instanceId === instance.id)
    .slice()
    .sort((left, right) => right.version - left.version);
  const boundVersion = instanceVersions.find((entry) => entry.id === instance.publishedVersionId);
  const disabled = pending || busy || Boolean(activeRun) || !isDesktop;
  let bindingMessage = t("versionBindingNone");
  if (boundVersion) {
    bindingMessage = t("versionBindingBound", { version: versionName(boundVersion.version) });
  }
  useEffect(
    () => () => {
      if (recorderOwned.current) void bridge.stopRecording().catch(() => undefined);
      onRecordingChange(false);
    },
    [onRecordingChange],
  );
  useEffect(() => {
    setUrl(instance.targetUrl);
  }, [instance.targetUrl]);
  async function perform(operation: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await operation();
    } catch (failure) {
      setError(t(errorMessageKey(failure)));
    } finally {
      setBusy(false);
    }
  }
  function validate() {
    const parsed = collectionWorkflowSchema.safeParse(workflow);
    if (!parsed.success) {
      setError(
        t("flowInvalidScript") +
          " · " +
          parsed.error.issues.map((issue) => issue.path.join(".")).join(", "),
      );
      return;
    }
    try {
      const values = workflowParametersSchema.parse(JSON.parse(parameters));
      const missing = workflow.before.flatMap((action) => {
        if (action.kind !== "fill") return [];
        return [...action.value.matchAll(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/gu)]
          .map((match) => match[1] ?? "")
          .filter((key) => !Object.hasOwn(values, key));
      });
      if (missing.length) {
        setError(`${t("flowMissingParams")} ${[...new Set(missing)].join(", ")}`);
        return;
      }
      setError("");
      setMessage(t("flowValid"));
      return { workflow: parsed.data, parameters: values };
    } catch {
      setError(t("flowInvalidParams"));
    }
  }
  /** Keeps the editable draft current without changing what execution uses. */
  async function saveDraft() {
    const validated = validate();
    if (!validated) return;
    await perform(async () => {
      await bridge.saveWorkflow(instance.id, validated.workflow, {
        name: instance.name,
        targetUrl: url,
        profileId: workspace.selectedProfileId,
        enabled: instance.enabled,
      });
      await onRefresh();
      setMessage(t("flowSaved"));
    });
  }
  /** Draft edits only take effect once published; publishing identical content reuses its version. */
  async function publish(run: boolean) {
    const validated = validate();
    if (!validated) return;
    await perform(async () => {
      await bridge.saveWorkflow(instance.id, validated.workflow, {
        name: instance.name,
        targetUrl: url,
        profileId: workspace.selectedProfileId,
        enabled: instance.enabled,
      });
      const version = await bridge.publishWorkflow(instance.id);
      await onRefresh();
      if (run) {
        onAcceptRun(await bridge.startRun(instance.id, validated.parameters));
        setTab("runs");
        return;
      }
      setMessage(t("versionPublished", { version: versionName(version.version) }));
      setTab("versions");
    });
  }
  /** Runs whatever is currently published, so switching versions is never undone by running. */
  async function runBound() {
    let values: Record<string, string>;
    try {
      values = workflowParametersSchema.parse(JSON.parse(parameters || "{}"));
    } catch {
      setError(t("flowInvalidParams"));
      return;
    }
    await perform(async () => {
      onAcceptRun(await bridge.startRun(instance.id, values));
      setTab("runs");
    });
  }
  async function switchVersion(versionId: string, version: number) {
    await perform(async () => {
      await bridge.rollbackWorkflow(instance.id, versionId);
      await onRefresh();
      setMessage(t("versionSwitched", { version: versionName(version) }));
    });
  }
  async function exportCurrent(versionId: string) {
    await perform(async () => {
      const path = await bridge.exportVersion(versionId);
      if (!path) {
        setMessage(t("versionExportCancelled"));
        return;
      }
      setMessage(t("versionExportDone", { path }));
    });
  }
  async function importFromFile() {
    await perform(async () => {
      const version = await bridge.importVersion(instance.id);
      await onRefresh();
      setMessage(t("versionImported", { version: versionName(version.version) }));
    });
  }
  /** Fixed input/output schema preview derived from the current draft. */
  async function showPlan() {
    const validated = validate();
    if (!validated) return;
    await perform(async () => {
      const plan = await bridge.planWorkflow(validated.workflow);
      setMessage(
        t("flowPlanSummary", {
          input: plan.input.join(", ") || "—",
          output: plan.output.join(", "),
          pages: String(plan.maxPages),
        }),
      );
    });
  }
  /** Bounded single-page dry run of the draft: never persisted to run history. */
  async function dryRunDraft() {
    const validated = validate();
    if (!validated) return;
    await perform(async () => {
      onAcceptRun(await bridge.dryRun(instance.id, validated.workflow, validated.parameters));
      setTab("runs");
    });
  }
  function useLastClick() {
    const last = workflow.before.at(-1);
    if (last?.kind !== "click") return;
    setWorkflow({
      ...workflow,
      before: workflow.before.slice(0, -1),
      pagination: { next: last.selector, maxPages: 2 },
    });
    setMessage(t("flowMovedToLoop"));
  }
  return (
    <div className="instance-detail">
      <header className="instance-detail-header">
        <Button
          tone="ghost"
          disabled={recording || busy}
          aria-label={t("backToInstances")}
          onClick={onBack}
        >
          <ArrowLeft size={16} />
        </Button>
        <div className="instance-detail-title">
          <div>
            <h1>{instance.name}</h1>
            <p>{t("flowJourney")}</p>
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
            <Button
              tone="primary"
              disabled={disabled || recording || !instance.enabled}
              onClick={() => {
                if (instance.workflow || workflow.extract.items) {
                  void runBound();
                  return;
                }
                onRun();
                setTab("runs");
              }}
            >
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
            disabled={recording || busy}
            className={cn("instance-tab", tab === entry.id && "is-active")}
            onClick={() => setTab(entry.id)}
          >
            <entry.icon size={14} />
            {t(entry.key)}
          </button>
        ))}
      </nav>
      {message && (
        <p className="workflow-feedback" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="workflow-feedback workflow-error" role="alert">
          {error}
        </p>
      )}
      <div className="instance-detail-content">
        {tab === "browser" && (
          <div className="collection-browser collection-split">
            <div className="split-browser">
              <div className="recording-toolbar">
                <div>
                  <strong>{t("flowRecordTitle")}</strong>
                  <p>{t("flowRecordHint")}</p>
                </div>
                {!recording && (
                  <Button
                    disabled={disabled}
                    onClick={() =>
                      void perform(async () => {
                        await bridge.startRecording();
                        recorderOwned.current = true;
                        setRecording(true);
                        onRecordingChange(true);
                      })
                    }
                  >
                    <Circle size={13} />
                    {t("flowStartRecording")}
                  </Button>
                )}
                {recording && (
                  <Button
                    tone="danger"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const recorded = await bridge.stopRecording();
                        recorderOwned.current = false;
                        setRecording(false);
                        onRecordingChange(false);
                        setUrl(recorded.url);
                        setWorkflow({ ...workflow, before: recorded.actions });
                        setMessage(
                          t("flowRecorded", {
                            count: recorded.actions.length,
                            skipped: recorded.skipped,
                          }),
                        );
                      })
                    }
                  >
                    <Square size={13} />
                    {t("flowStopRecording")}
                  </Button>
                )}
              </div>
              {recording && (
                <p className="recording-indicator" role="status">
                  {t("flowRecording")}
                </p>
              )}
              <BrowserPanel
                profiles={workspace.profiles}
                selectedProfileId={workspace.selectedProfileId}
                disabled={disabled || recording}
                url={url}
                onUrlChange={setUrl}
                onNavigate={() => onNavigate(url)}
                onSelectProfile={onSelectProfile}
              />
              <div className="workflow-actions browser-next">
                <Button
                  disabled={disabled || recording}
                  onClick={() => {
                    setUrl("https://quotes.toscrape.com/");
                    setWorkflow(structuredClone(quotesWorkflow));
                    onNavigate("https://quotes.toscrape.com/");
                    setMessage(t("flowPresetLoaded"));
                  }}
                >
                  {t("flowQuotesPreset")}
                </Button>
                <Button
                  disabled={disabled || recording}
                  onClick={() => {
                    setUrl("https://www.tiktok.com/@_forexsignals_");
                    setWorkflow(structuredClone(tiktokProfileWorkflow));
                    onNavigate("https://www.tiktok.com/@_forexsignals_");
                    setMessage(t("flowTiktokPresetLoaded"));
                  }}
                >
                  {t("flowTiktokPreset")}
                </Button>
              </div>
            </div>
            <div className="split-config">
              <div className="workflow-workspace">
                <div className="workflow-intro">
                  <div>
                    <h2>{t("flowRecipeTitle")}</h2>
                    <p>{t("flowRecipeHint")}</p>
                  </div>
                  <Badge>{t("flowExecutable")}</Badge>
                </div>
                <label className="workflow-field">
                  {t("targetUrl")}
                  <input
                    value={url}
                    disabled={disabled}
                    onChange={(event) => setUrl(event.target.value)}
                  />
                </label>
                {workflow.before.at(-1)?.kind === "click" && (
                  <Button disabled={disabled} onClick={useLastClick}>
                    {t("flowLastClickLoop")}
                  </Button>
                )}
                <CollectionEditor
                  workflow={workflow}
                  onChange={setWorkflow}
                  disabled={disabled}
                  url={url}
                />
                <section className="workflow-section">
                  <h2>{t("flowParameters")}</h2>
                  <p className="workflow-muted">{t("flowParametersHint")}</p>
                  <textarea
                    className="workflow-parameters"
                    aria-label={t("flowParameters")}
                    value={parameters}
                    spellCheck={false}
                    disabled={disabled}
                    onChange={(event) => setParameters(event.target.value)}
                  />
                </section>
                <div className="workflow-actions workflow-footer">
                  <Button disabled={disabled} onClick={validate}>
                    {t("flowCheck")}
                  </Button>
                  <Button disabled={disabled} onClick={() => void showPlan()}>
                    {t("flowPlan")}
                  </Button>
                  <Button disabled={disabled} onClick={() => void dryRunDraft()}>
                    <FlaskConical size={13} />
                    {t("flowDryRun")}
                  </Button>
                  <Button disabled={disabled} onClick={() => void saveDraft()}>
                    <Save size={13} />
                    {t("flowSave")}
                  </Button>
                  <Button disabled={disabled} onClick={() => void publish(false)}>
                    <History size={13} />
                    {t("versionPublish")}
                  </Button>
                  <Button
                    tone="primary"
                    disabled={disabled || !instance.enabled}
                    onClick={() => void publish(true)}
                  >
                    <Play size={13} />
                    {t("flowSaveRun")}
                  </Button>
                </div>
                <details className="workflow-api">
                  <summary>{t("flowApi")}</summary>
                  <p>{t("flowApiHint")}</p>
                  <pre>{JSON.stringify({ instanceId: instance.id, parameters: {} }, null, 2)}</pre>
                  <code>{"/v1/jobs → /v1/jobs/:id → /v1/jobs/:id/result?format=csv"}</code>
                </details>
              </div>
            </div>
          </div>
        )}
        {tab === "versions" && (
          <div className="workflow-workspace">
            <div className="workflow-intro">
              <div>
                <h2>{t("versionBindingTitle")}</h2>
                <p>{bindingMessage}</p>
              </div>
              {boundVersion && <Badge>{versionName(boundVersion.version)}</Badge>}
            </div>
            <section className="workflow-section">
              <h2>{t("versionTitle")}</h2>
              <p className="workflow-muted">{t("versionHint")}</p>
              {instanceVersions.length === 0 && (
                <p className="workflow-muted">{t("versionEmpty")}</p>
              )}
              <ul className="version-list">
                {instanceVersions.map((version) => (
                  <li
                    key={version.id}
                    className={cn(
                      "version-row",
                      version.id === instance.publishedVersionId && "is-active",
                    )}
                  >
                    <strong>{versionName(version.version)}</strong>
                    <span className="workflow-muted">{formatDate(version.publishedAt)}</span>
                    <span>{version.note}</span>
                    {version.id === instance.publishedVersionId && (
                      <Badge tone="success">{t("versionInUse")}</Badge>
                    )}
                    {version.id !== instance.publishedVersionId && (
                      <Button
                        disabled={disabled}
                        onClick={() => void switchVersion(version.id, version.version)}
                      >
                        {t("versionSwitch", { version: versionName(version.version) })}
                      </Button>
                    )}
                    <Button
                      disabled={disabled}
                      aria-label={t("versionExport")}
                      onClick={() => void exportCurrent(version.id)}
                    >
                      {t("versionExport")}
                    </Button>
                  </li>
                ))}
              </ul>
              <p className="workflow-muted">{t("versionSwitchNote")}</p>
              <div className="workflow-actions">
                <Button disabled={disabled} onClick={() => void importFromFile()}>
                  {t("versionImport")}
                </Button>
              </div>
              <p className="workflow-muted">{t("versionImportHint")}</p>
            </section>
          </div>
        )}
        {tab === "config" && (
          <InstanceConfiguration
            key={instance.updatedAt}
            instance={instance}
            workspace={workspace}
            disabled={disabled}
            onSave={onUpdate}
            onClearWatermark={onClearWatermark}
          />
        )}
        {tab === "runs" && <RunsPage runs={instanceRuns} onCopyError={onCopyError} />}
      </div>
    </div>
  );
}
