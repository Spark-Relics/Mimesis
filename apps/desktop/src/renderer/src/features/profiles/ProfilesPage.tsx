import type { WorkspaceSnapshot } from "@clawler/contracts";
import { useI18n } from "@clawler/i18n";
import { Badge, Button, Panel } from "@clawler/ui";
import { ArrowRight, FolderLock, Plus } from "lucide-react";
import { useState } from "react";

export function ProfilesPage({
  workspace,
  disabled,
  onCreate,
  onSelect,
}: {
  workspace: WorkspaceSnapshot;
  disabled: boolean;
  onCreate(name: string): void;
  onSelect(id: string): void;
}) {
  const { t, formatDate } = useI18n();
  const [name, setName] = useState("");
  return (
    <div>
      <header className="page-heading">
        <div>
          <div className="eyebrow">{t("isolatedSession")}</div>
          <h1>{t("profilesTitle")}</h1>
          <p>{t("profilesDescription")}</p>
        </div>
      </header>
      <form
        className="create-profile"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate(name);
        }}
      >
        <label htmlFor="profile-name">{t("profileName")}</label>
        <input
          id="profile-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("profilePlaceholder")}
          maxLength={64}
          required
          disabled={disabled}
        />
        <Button type="submit" tone="primary" disabled={disabled || !name.trim()}>
          <Plus size={15} />
          {t("createProfile")}
        </Button>
      </form>
      <div className="profile-grid">
        {workspace.profiles.map((profile) => (
          <Panel className="profile-card" key={profile.id}>
            <div className="profile-card__top">
              <span className="profile-icon">
                <FolderLock size={24} />
              </span>
              {workspace.selectedProfileId === profile.id && (
                <Badge tone="success">{t("activeProfile")}</Badge>
              )}
            </div>
            <h2>{profile.name}</h2>
            <p>{t("createdAt", { date: formatDate(profile.createdAt) })}</p>
            <div className="profile-id">
              <span>{t("profileId")}</span>
              <code>{profile.id.slice(0, 8)}</code>
            </div>
            <Button
              disabled={disabled || workspace.selectedProfileId === profile.id}
              onClick={() => onSelect(profile.id)}
            >
              {t("switchProfile")}
              <ArrowRight size={13} />
            </Button>
          </Panel>
        ))}
      </div>
    </div>
  );
}
