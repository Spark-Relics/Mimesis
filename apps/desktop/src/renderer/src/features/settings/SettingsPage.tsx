import { resolveLocale, useI18n } from "@clawler/i18n";
import { Badge, Panel } from "@clawler/ui";
import { Globe2, Layers3, ShieldCheck } from "lucide-react";
import { isDesktop } from "../../platform/bridge";
import { StorageSettings } from "./StorageSettings";

export function SettingsPage() {
  const { t, locale, setLocale } = useI18n();
  let runtimeKey: "desktopMode" | "previewMode" = "previewMode";
  if (isDesktop) runtimeKey = "desktopMode";
  return (
    <div className="settings-page">
      <header className="page-heading">
        <div>
          <div className="eyebrow">{t("workspace")}</div>
          <h1>{t("settingsTitle")}</h1>
          <p>{t("settingsDescription")}</p>
        </div>
      </header>
      <Panel className="settings-panel">
        <div className="setting-row">
          <Globe2 size={21} />
          <div>
            <h2>{t("language")}</h2>
            <p>{t("languageDescription")}</p>
          </div>
          <select
            aria-label={t("language")}
            value={locale}
            onChange={(event) => {
              void setLocale(resolveLocale(event.target.value));
            }}
          >
            <option value="zh-CN">{t("localeZh")}</option>
            <option value="en-US">{t("localeEn")}</option>
          </select>
        </div>
      </Panel>
      <StorageSettings />
      <Panel className="settings-panel">
        <div className="setting-row">
          <ShieldCheck size={21} />
          <div>
            <h2>{t("runtimeTitle")}</h2>
            <p>{t("runtimeDescription")}</p>
          </div>
          <Badge tone="success">{t(runtimeKey)}</Badge>
        </div>
        <div className="setting-row">
          <Layers3 size={21} />
          <div>
            <h2>{t("scaffoldScope")}</h2>
            <p>{t("scaffoldDescription")}</p>
          </div>
          <Badge>{t("foundation")}</Badge>
        </div>
      </Panel>
    </div>
  );
}
