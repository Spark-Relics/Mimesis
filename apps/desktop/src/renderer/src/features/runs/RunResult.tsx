import type { Run } from "@clawler/contracts";
import { useI18n } from "@clawler/i18n";
import { Badge, Button, EmptyState, Panel } from "@clawler/ui";
import { Check, CircleDashed, Copy, FileJson2, ListChecks } from "lucide-react";
import { useState } from "react";
import { errorKeys, statusKeys, statusTones, stepKeys } from "../../shared/presentation";

export function RunResult({ run, onCopyError }: { run: Run | undefined; onCopyError(): void }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  let copyLabel = t("copyJson");
  if (copied) copyLabel = t("copied");

  async function copyResult() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(run?.result, null, 2));
      setCopied(true);
    } catch {
      onCopyError();
    }
  }

  if (!run)
    return (
      <Panel className="result-panel">
        <div className="panel-heading">
          <div className="label-with-icon">
            <FileJson2 size={15} />
            <strong>{t("results")}</strong>
          </div>
          <Badge>{t("ready")}</Badge>
        </div>
        <EmptyState
          icon={<CircleDashed size={24} />}
          title={t("ready")}
          description={t("readyDescription")}
        />
      </Panel>
    );

  return (
    <Panel className="result-panel">
      <div className="panel-heading">
        <div className="label-with-icon">
          <FileJson2 size={15} />
          <strong>{t("results")}</strong>
          <Badge tone={statusTones[run.status]}>{t(statusKeys[run.status])}</Badge>
        </div>
        {run.result && (
          <Button
            tone="ghost"
            onClick={() => {
              void copyResult();
            }}
          >
            <Copy size={13} />
            {copyLabel}
          </Button>
        )}
      </div>
      <div className="run-result-grid">
        <div className="step-list">
          <div className="section-label">
            <ListChecks size={13} />
            {t("steps")}
          </div>
          {run.steps.map((step) => (
            <div className={`step step--${step.status}`} key={step.id}>
              <span className="step-dot">
                <Check size={10} />
              </span>
              <span>{t(stepKeys[step.kind])}</span>
              <small>{t(statusKeys[step.status])}</small>
            </div>
          ))}
          {run.errorCode && (
            <p role="alert" className="inline-error">
              {t(errorKeys[run.errorCode])}
            </p>
          )}
        </div>
        <section className="result-data" aria-label={t("jsonPreview")}>
          <pre className="result-json">{JSON.stringify(run.result, null, 2)}</pre>
        </section>
      </div>
    </Panel>
  );
}
