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
  Braces,
  Circle,
  FileClock,
  Globe2,
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
import { CollectionEditor, emptyWorkflow, quotesWorkflow } from "./CollectionEditor";
import { InstanceConfiguration } from "./InstanceConfiguration";

const detailTabs = [
  { id: "browser", key: "flowBrowse", icon: Globe2 },
  { id: "workflow", key: "flowConfigure", icon: Braces },
  { id: "config", key: "instanceConfig", icon: Settings2 },
  { id: "runs", key: "instanceRuns", icon: FileClock },
] as const;
type DetailTab = (typeof detailTabs)[number]["id"];

export function InstanceDetailPage({
  instance,
  workspace,
  pending,
  onBack,
  onRefresh,
  onAcceptRun,
  onRecordingChange,
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
  onRefresh(): Promise<void>;
  onAcceptRun(run: Run): void;
  onRecordingChange(recording: boolean): void;
  onUpdate(input: InstanceUpdate): void;
  onRun(): void;
  onCancel(id: string): void;
  onNavigate(url: string): void;
  onSelectProfile(id: string): void;
  onCopyError(): void;
}) {
  const { t } = useI18n();
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
  const disabled = pending || busy || Boolean(activeRun) || !isDesktop;
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
  async function save(run: boolean) {
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
      if (run) {
        onAcceptRun(await bridge.startRun(instance.id, validated.parameters));
        setTab("runs");
      } else setMessage(t("flowSaved"));
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
                  void save(true);
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
          <div className="collection-browser">
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
                      setTab("workflow");
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
                tone="primary"
                disabled={recording || busy}
                onClick={() => setTab("workflow")}
              >
                {t("flowConfigure")}
              </Button>
            </div>
          </div>
        )}
        {tab === "workflow" && (
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
            <CollectionEditor workflow={workflow} onChange={setWorkflow} disabled={disabled} />
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
              <Button disabled={disabled} onClick={() => void save(false)}>
                <Save size={13} />
                {t("flowSave")}
              </Button>
              <Button
                tone="primary"
                disabled={disabled || !instance.enabled}
                onClick={() => void save(true)}
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
        )}
        {tab === "config" && (
          <InstanceConfiguration
            key={instance.updatedAt}
            instance={instance}
            workspace={workspace}
            disabled={disabled}
            onSave={onUpdate}
          />
        )}
        {tab === "runs" && <RunsPage runs={instanceRuns} onCopyError={onCopyError} />}
      </div>
    </div>
  );
}
