import type { StorageLocation } from "@clawler/contracts";
import { type MessageKey, useI18n } from "@clawler/i18n";
import { Badge, Button, Panel } from "@clawler/ui";
import { Database, Files, FolderOpen, Globe2 } from "lucide-react";
import { useEffect, useState } from "react";
import { bridge, isDesktop } from "../../platform/bridge";
import { errorMessageKey } from "../../shared/presentation";
import "./storage.css";

const sourceKeys: Record<StorageLocation["source"], MessageKey> = {
  default: "storageDefault",
  configuration: "storageConfigured",
  environment: "storageEnvironment",
};
const scope = [
  { icon: Database, title: "storageWorkspace", hint: "storageWorkspaceHint" },
  { icon: Files, title: "storageArtifacts", hint: "storageArtifactsHint" },
  { icon: Globe2, title: "storageBrowser", hint: "storageBrowserHint" },
] as const;

const backupNoticeKeys: Record<"backup" | "restore", MessageKey> = {
  backup: "storageBackupPending",
  restore: "storageBackupPendingRestore",
};

export function StorageSettings() {
  const { t } = useI18n();
  const [location, setLocation] = useState<StorageLocation>();
  const [destination, setDestination] = useState("");
  const [backupPath, setBackupPath] = useState("");
  const [restorePath, setRestorePath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey>();
  const [notice, setNotice] = useState<MessageKey>();
  useEffect(() => {
    if (!isDesktop) return;
    let active = true;
    void bridge
      .getStorageLocation()
      .then((value) => {
        if (active) {
          setLocation(value);
          setDestination(value.pending ?? "");
        }
      })
      .catch((failure: unknown) => {
        if (active) setError(errorMessageKey(failure));
      });
    return () => {
      active = false;
    };
  }, []);

  async function action(operation: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await operation();
    } catch (failure) {
      setError(errorMessageKey(failure));
    } finally {
      setBusy(false);
    }
  }
  const locked = busy || location?.source === "environment";
  const planLocked =
    locked ||
    Boolean(location?.pending) ||
    (location?.pendingBackupKind !== undefined && location.pendingBackupKind !== null);
  return (
    <Panel className="storage-settings" aria-busy={busy}>
      <header className="storage-heading">
        <FolderOpen size={22} />
        <div>
          <h2>{t("storageTitle")}</h2>
          <p>{t("storageDescription")}</p>
        </div>
      </header>
      {!isDesktop && <p>{t("desktopRequired")}</p>}
      {isDesktop && !location && !error && <p role="status">{t("loading")}</p>}
      {error && (
        <div className="storage-error" role="alert">
          <p>{t(error)}</p>
          {!location && (
            <Button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  setLocation(await bridge.getStorageLocation());
                })
              }
            >
              {t("retry")}
            </Button>
          )}
        </div>
      )}
      {location && (
        <>
          <div className="storage-current-label">
            <label htmlFor="storage-current">{t("storageCurrent")}</label>
            <Badge>{t(sourceKeys[location.source])}</Badge>
          </div>
          <div className="storage-path-row">
            <input id="storage-current" readOnly value={location.current} />
            <Button
              disabled={busy}
              onClick={() => void action(() => bridge.openStorageDirectory())}
            >
              {t("storageOpen")}
            </Button>
          </div>
          <dl className="storage-scope">
            {scope.map((entry) => (
              <div key={entry.title}>
                <entry.icon size={19} />
                <div>
                  <dt>{t(entry.title)}</dt>
                  <dd>{t(entry.hint)}</dd>
                </div>
              </div>
            ))}
          </dl>
          {location.source === "environment" && (
            <p className="storage-hint">{t("storageEnvironmentHint")}</p>
          )}
          {location.source !== "environment" && (
            <section className="storage-backup">
              <h3>{t("storageBackupTitle")}</h3>
              <p className="storage-hint">{t("storageBackupDescription")}</p>
              {location.pendingBackup && (
                <div className="storage-pending" role="status">
                  <strong>{t(backupNoticeKeys[location.pendingBackupKind ?? "backup"])}</strong>
                  <code>{location.pendingBackup}</code>
                </div>
              )}
              {!location.pendingBackup && (
                <>
                  <label htmlFor="storage-backup-target">{t("storageBackupTarget")}</label>
                  <div className="storage-path-row">
                    <input
                      id="storage-backup-target"
                      value={backupPath}
                      disabled={planLocked}
                      spellCheck={false}
                      onChange={(event) => setBackupPath(event.target.value)}
                    />
                    <Button
                      disabled={planLocked}
                      onClick={() =>
                        void action(async () => {
                          const path = await bridge.chooseStorageDirectory();
                          if (path) setBackupPath(path);
                        })
                      }
                    >
                      {t("storageBrowse")}
                    </Button>
                    <Button
                      tone="primary"
                      disabled={planLocked || !backupPath.trim()}
                      onClick={() =>
                        void action(async () => {
                          setLocation(await bridge.scheduleStorageBackup("backup", backupPath));
                          setNotice("storageBackupDone");
                        })
                      }
                    >
                      {t("storageBackupCreate")}
                    </Button>
                  </div>
                  <label htmlFor="storage-backup-restore">{t("storageBackupRestoreFrom")}</label>
                  <div className="storage-path-row">
                    <input
                      id="storage-backup-restore"
                      value={restorePath}
                      disabled={planLocked}
                      spellCheck={false}
                      onChange={(event) => setRestorePath(event.target.value)}
                    />
                    <Button
                      disabled={planLocked}
                      onClick={() =>
                        void action(async () => {
                          const path = await bridge.chooseStorageDirectory();
                          if (path) setRestorePath(path);
                        })
                      }
                    >
                      {t("storageBrowse")}
                    </Button>
                    <Button
                      tone="primary"
                      disabled={planLocked || !restorePath.trim()}
                      onClick={() =>
                        void action(async () => {
                          setLocation(await bridge.scheduleStorageBackup("restore", restorePath));
                          setNotice("storageBackupPendingRestore");
                        })
                      }
                    >
                      {t("storageBackupRestore")}
                    </Button>
                  </div>
                  <p className="storage-hint">{t("storageBackupHint")}</p>
                </>
              )}
              {location.pendingBackup && (
                <div className="storage-actions">
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        setLocation(await bridge.cancelStorageBackup());
                        setNotice("storageBackupCancelled");
                      })
                    }
                  >
                    {t("storageBackupCancel")}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => void action(() => bridge.controlWindow("close"))}
                  >
                    {t("storageExit")}
                  </Button>
                </div>
              )}
            </section>
          )}
          {location.source !== "environment" && (
            <>
              <label htmlFor="storage-destination">{t("storageDestination")}</label>
              <div className="storage-path-row">
                <input
                  id="storage-destination"
                  value={destination}
                  disabled={locked}
                  spellCheck={false}
                  onChange={(event) => setDestination(event.target.value)}
                  aria-describedby="storage-hint"
                />
                <Button
                  disabled={locked}
                  onClick={() =>
                    void action(async () => {
                      const path = await bridge.chooseStorageDirectory();
                      if (path) setDestination(path);
                    })
                  }
                >
                  {t("storageBrowse")}
                </Button>
              </div>
              <p id="storage-hint" className="storage-hint">
                {t("storageHint")}
              </p>
              {location.pending && (
                <div className="storage-pending" role="status">
                  <strong>{t("storageNextLaunch")}</strong>
                  <code>{location.pending}</code>
                  <p>{t("storagePending")}</p>
                </div>
              )}
              <div className="storage-actions">
                {location.pending && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        setLocation(await bridge.cancelStorageDirectory());
                        setDestination("");
                        setNotice("storageCancelled");
                      })
                    }
                  >
                    {t("storageCancel")}
                  </Button>
                )}
                {location.pending && (
                  <Button
                    disabled={busy}
                    onClick={() => void action(() => bridge.controlWindow("close"))}
                  >
                    {t("storageExit")}
                  </Button>
                )}
                <Button
                  tone="primary"
                  disabled={
                    locked ||
                    !destination.trim() ||
                    destination.trim() === location.current ||
                    destination.trim() === location.pending
                  }
                  onClick={() =>
                    void action(async () => {
                      setLocation(await bridge.scheduleStorageDirectory(destination));
                    })
                  }
                >
                  {t("storageSchedule")}
                </Button>
              </div>
            </>
          )}
          {busy && <p role="status">{t("loading")}</p>}
          {notice && <p role="status">{t(notice)}</p>}
        </>
      )}
    </Panel>
  );
}
