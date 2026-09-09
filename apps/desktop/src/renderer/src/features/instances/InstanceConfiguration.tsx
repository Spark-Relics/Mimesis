import type { AutomationInstance, InstanceUpdate, WorkspaceSnapshot } from "@clawler/contracts";
import { useI18n } from "@clawler/i18n";
import { Button, Panel } from "@clawler/ui";
import { Save } from "lucide-react";
import { useState } from "react";

export function InstanceConfiguration({
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
