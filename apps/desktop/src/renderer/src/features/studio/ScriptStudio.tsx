import { DEMO_URL, type Run, type WorkspaceSnapshot } from "@clawler/contracts";
import { useI18n } from "@clawler/i18n";
import { Badge, Button, CodeEditor, cn } from "@clawler/ui";
import { ArrowUpRight, Braces, Code2, Leaf, Play, Save, Sparkles, Square, X } from "lucide-react";
import { useState } from "react";
import { BrowserPanel } from "../browser/BrowserPanel";
import { RunResult } from "../runs/RunResult";

interface ScriptStudioProps {
  workspace: WorkspaceSnapshot;
  pending: boolean;
  instanceId: string;
  initialUrl: string;
  onSave(source: string): Promise<void>;
  onRun(url: string): void;
  onCancel(id: string): void;
  onNavigate(url: string): void;
  onSelectProfile(id: string): void;
  onCopyError(): void;
}

function RunButton({
  activeRun,
  disabled,
  onRun,
  onCancel,
}: {
  activeRun: Run | undefined;
  disabled: boolean;
  onRun(): void;
  onCancel(id: string): void;
}) {
  const { t } = useI18n();
  if (activeRun)
    return (
      <Button tone="danger" onClick={() => onCancel(activeRun.id)} disabled={disabled}>
        <Square size={12} />
        {t("cancel")}
      </Button>
    );
  return (
    <Button tone="primary" onClick={onRun} disabled={disabled}>
      <Play size={13} />
      {t("run")}
    </Button>
  );
}

export function ScriptStudio({
  workspace,
  pending,
  instanceId,
  initialUrl,
  onSave,
  onRun,
  onCancel,
  onNavigate,
  onSelectProfile,
  onCopyError,
}: ScriptStudioProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"published" | "draft">("published");
  const [source, setSource] = useState(workspace.draft.source);
  const [url, setUrl] = useState(initialUrl);
  const [showAssistant, setShowAssistant] = useState(false);
  const instanceRuns = workspace.runs.filter((run) => run.instanceId === instanceId);
  const activeRun = instanceRuns.find((run) => run.status === "running");
  const locked = pending || Boolean(activeRun);
  let visibleSource = workspace.publishedSource;
  let noticeKey: "publishedNotice" | "draftNotice" = "publishedNotice";
  if (mode === "draft") {
    visibleSource = source;
    noticeKey = "draftNotice";
  }
  let saveStatus: "saved" | "unsaved" = "saved";
  if (source !== workspace.draft.source) saveStatus = "unsaved";

  return (
    <div className="studio-page">
      <header className="page-heading">
        <div>
          <div className="eyebrow">{t("studioEyebrow")}</div>
          <h1>{t("studioTitle")}</h1>
          <p>{t("studioDescription")}</p>
        </div>
        <Button
          tone="ghost"
          aria-label={t("toggleAssistant")}
          onClick={() => setShowAssistant(!showAssistant)}
        >
          <Sparkles size={16} />
        </Button>
      </header>
      <div className="script-toolbar">
        <div className="script-identity">
          <span className="script-icon">
            <Code2 size={22} />
          </span>
          <div>
            <div className="script-title">
              <strong>{t("scriptTitle")}</strong>
              <Badge>{t("version", { version: "1.0.0" })}</Badge>
            </div>
            <p>{t("scriptDescription")}</p>
          </div>
        </div>
        <div className="toolbar-actions">
          <Badge tone="success">
            <Leaf size={10} />
            {t("noAi")}
          </Badge>
          <RunButton
            activeRun={activeRun}
            disabled={pending}
            onRun={() => onRun(url)}
            onCancel={onCancel}
          />
        </div>
      </div>
      {showAssistant && (
        <div className="assistant-callout">
          <Sparkles size={20} />
          <div>
            <strong>{t("aiTitle")}</strong>
            <p>{t("aiDescription")}</p>
            <Badge>{t("aiNotConnected")}</Badge>
          </div>
          <Button tone="ghost" aria-label={t("close")} onClick={() => setShowAssistant(false)}>
            <X size={15} />
          </Button>
        </div>
      )}
      <div className="studio-grid">
        <section className="editor-panel panel">
          <div className="panel-heading">
            <div className="label-with-icon">
              <Braces size={15} />
              <strong>{t("sourceFile")}</strong>
            </div>
            <span className="file-language">{t("bundled")}</span>
          </div>
          <div className="editor-tabs">
            {(["published", "draft"] as const).map((tab) => (
              <button
                type="button"
                key={tab}
                className={cn("editor-tab", mode === tab && "is-active")}
                onClick={() => setMode(tab)}
              >
                {t(tab)}
              </button>
            ))}
            <span className="save-status">{t(saveStatus)}</span>
          </div>
          <CodeEditor
            label={t("sourceLabel")}
            value={visibleSource}
            readOnly={mode === "published"}
            onChange={setSource}
          />
          <div className="editor-note">
            <span className="note-dot" />
            <p>{t(noticeKey)}</p>
          </div>
          <div className="parameter-section">
            <div className="parameter-heading">
              <strong>{t("parameters")}</strong>
              <button
                type="button"
                className="text-button"
                onClick={() => setUrl(DEMO_URL)}
                disabled={locked}
              >
                {t("useDemo")}
                <ArrowUpRight size={11} />
              </button>
            </div>
            <label htmlFor="target-url">{t("targetUrl")}</label>
            <input
              id="target-url"
              value={url}
              placeholder={t("targetPlaceholder")}
              disabled={locked}
              onChange={(event) => setUrl(event.target.value)}
            />
            <p>{t("urlHint")}</p>
          </div>
          {mode === "draft" && (
            <div className="editor-footer">
              <Button
                onClick={() => {
                  void onSave(source);
                }}
                disabled={locked}
              >
                <Save size={13} />
                {t("saveDraft")}
              </Button>
            </div>
          )}
        </section>
        <BrowserPanel
          profiles={workspace.profiles}
          selectedProfileId={workspace.selectedProfileId}
          disabled={locked}
          url={url}
          onUrlChange={setUrl}
          onNavigate={() => onNavigate(url)}
          onSelectProfile={onSelectProfile}
        />
      </div>
      <RunResult run={instanceRuns[0]} onCopyError={onCopyError} />
    </div>
  );
}
