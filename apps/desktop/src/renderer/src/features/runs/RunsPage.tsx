import type { Run } from "@clawler/contracts";
import { useI18n } from "@clawler/i18n";
import { Badge, Button, EmptyState, Panel } from "@clawler/ui";
import { History } from "lucide-react";
import { useState } from "react";
import { statusKeys, statusTones } from "../../shared/presentation";
import { RunResult } from "./RunResult";

export function RunsPage({ runs, onCopyError }: { runs: Run[]; onCopyError(): void }) {
  const { t, formatDate } = useI18n();
  const [selectedId, setSelectedId] = useState<string>();
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0];
  return (
    <div>
      <header className="page-heading">
        <div>
          <div className="eyebrow">{t("localRuntime")}</div>
          <h1>{t("runsTitle")}</h1>
          <p>{t("runsDescription")}</p>
        </div>
      </header>
      {runs.length === 0 && (
        <Panel>
          <EmptyState
            icon={<History size={30} />}
            title={t("noRuns")}
            description={t("noRunsDescription")}
          />
        </Panel>
      )}
      {runs.length > 0 && (
        <>
          <Panel className="history-panel">
            <table>
              <thead>
                <tr>
                  <th>{t("runId")}</th>
                  <th>{t("runTime")}</th>
                  <th>{t("runStatus")}</th>
                  <th>
                    <span className="sr-only">{t("viewRun")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <code>{run.id.slice(0, 8)}</code>
                      <small>{t("version", { version: run.version })}</small>
                    </td>
                    <td>{formatDate(run.startedAt)}</td>
                    <td>
                      <Badge tone={statusTones[run.status]}>{t(statusKeys[run.status])}</Badge>
                    </td>
                    <td>
                      <Button tone="ghost" onClick={() => setSelectedId(run.id)}>
                        {t("viewRun")}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <RunResult run={selected} onCopyError={onCopyError} />
        </>
      )}
    </div>
  );
}
