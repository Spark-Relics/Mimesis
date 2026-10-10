import type { AutomationInstance, InstanceUpdate, WorkspaceSnapshot } from "@clawler/contracts";
import { useI18n } from "@clawler/i18n";
import { Button, Panel } from "@clawler/ui";
import { CalendarClock, Save } from "lucide-react";
import { useState } from "react";

export function InstanceConfiguration({
  instance,
  workspace,
  disabled,
  onSave,
  onClearWatermark,
  onSetSchedule,
}: {
  instance: AutomationInstance;
  workspace: WorkspaceSnapshot;
  disabled: boolean;
  onSave(input: InstanceUpdate): void;
  onClearWatermark(): void;
  onSetSchedule(intervalMinutes: number | null): void;
}) {
  const { t, formatDate } = useI18n();
  const [name, setName] = useState(instance.name);
  const [targetUrl, setTargetUrl] = useState(instance.targetUrl);
  const [profileId, setProfileId] = useState(instance.profileId);
  const [enabled, setEnabled] = useState(instance.enabled);
  const [interval, setIntervalMinutes] = useState(
    instance.schedule ? String(instance.schedule.intervalMinutes) : "30",
  );
  const intervalValue = Number(interval);
  const intervalValid =
    Number.isInteger(intervalValue) && intervalValue >= 1 && intervalValue <= 1440;
  let watermarkLabel = t("watermarkNone");
  if (instance.lastWatermark !== undefined)
    watermarkLabel = t("watermarkValue", { value: instance.lastWatermark });
  let scheduleLabel = t("scheduleUnset");
  if (instance.schedule) {
    scheduleLabel = instance.nextRunAt
      ? t("scheduleNextRun", { time: formatDate(instance.nextRunAt) })
      : t("scheduleArmed");
  }
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
      <div className="instance-watermark">
        <div className="instance-section-heading">
          <div>
            <strong>{t("scheduleTitle")}</strong>
            <p>{t("scheduleHint")}</p>
          </div>
        </div>
        <p className="workflow-muted">{scheduleLabel}</p>
        <form
          className="instance-config-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (intervalValid) onSetSchedule(intervalValue);
          }}
        >
          <label htmlFor="config-schedule-interval">{t("scheduleInterval")}</label>
          <input
            id="config-schedule-interval"
            type="number"
            min={1}
            max={1440}
            step={1}
            required
            value={interval}
            disabled={disabled}
            onChange={(event) => setIntervalMinutes(event.target.value)}
          />
          <p className="workflow-muted">{t("scheduleIntervalHint")}</p>
          <div className="instance-config-actions">
            <Button type="submit" disabled={disabled || !intervalValid}>
              <CalendarClock size={13} />
              {t("scheduleSave")}
            </Button>
            {instance.schedule && (
              <Button disabled={disabled} onClick={() => onSetSchedule(null)}>
                {t("scheduleClear")}
              </Button>
            )}
          </div>
        </form>
        {instance.schedule && instance.publishedVersionId === null && (
          <p className="workflow-muted">{t("scheduleNeedsPublish")}</p>
        )}
      </div>
      {instance.workflow?.watermark && (
        <div className="instance-watermark">
          <div className="instance-section-heading">
            <div>
              <strong>{t("watermarkTitle")}</strong>
              <p>{t("watermarkHint")}</p>
            </div>
          </div>
          <p className="workflow-muted">{watermarkLabel}</p>
          {instance.lastWatermark !== undefined && (
            <>
              <div className="instance-config-actions">
                <Button disabled={disabled} onClick={onClearWatermark}>
                  {t("clearWatermark")}
                </Button>
              </div>
              <p className="workflow-muted">{t("clearWatermarkHint")}</p>
            </>
          )}
        </div>
      )}
    </Panel>
  );
}
