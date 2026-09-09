import type { Profile } from "@clawler/contracts";
import { useI18n } from "@clawler/i18n";
import { Badge, Button } from "@clawler/ui";
import { ArrowRight, Globe2, LockKeyhole, Monitor, RotateCw } from "lucide-react";
import { useEffect, useRef } from "react";
import { bridge, isDesktop } from "../../platform/bridge";

function BrowserSlot() {
  const container = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  useEffect(() => {
    if (!isDesktop || !container.current) return;
    const element = container.current;
    let frame = 0;
    function sync() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect();
        const parent = element.closest("main")?.getBoundingClientRect();
        const x = Math.max(0, rect.left, parent?.left ?? 0);
        const y = Math.max(0, rect.top, parent?.top ?? 0);
        const right = Math.min(window.innerWidth, rect.right, parent?.right ?? window.innerWidth);
        const bottom = Math.min(
          window.innerHeight,
          rect.bottom,
          parent?.bottom ?? window.innerHeight,
        );
        void bridge
          .setBrowserBounds({
            x,
            y,
            width: Math.max(0, right - x),
            height: Math.max(0, bottom - y),
            visible: true,
          })
          .catch(() => undefined);
      });
    }
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    sync();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
      void bridge
        .setBrowserBounds({ x: 0, y: 0, width: 0, height: 0, visible: false })
        .catch(() => undefined);
    };
  }, []);

  if (isDesktop)
    return <section className="browser-slot" ref={container} aria-label={t("browserTitle")} />;
  return (
    <div className="browser-slot preview-page">
      <div className="preview-page__masthead">
        <Globe2 size={16} />
        <span>{t("desktopPreview")}</span>
      </div>
      <div className="preview-page__hero">
        <span className="eyebrow">{t("demoHeading")}</span>
        <h2>{t("demoDescription")}</h2>
      </div>
      <div className="preview-cards">
        {(["demoItemOne", "demoItemTwo", "demoItemThree"] as const).map((key) => (
          <div className="preview-card" key={key}>
            <div className="preview-art">
              <i />
            </div>
            <span>{t(key)}</span>
          </div>
        ))}
      </div>
      <p className="preview-caption">{t("previewCaption")}</p>
    </div>
  );
}

interface BrowserPanelProps {
  profiles: Profile[];
  selectedProfileId: string;
  disabled: boolean;
  url: string;
  onUrlChange(value: string): void;
  onNavigate(): void;
  onSelectProfile(id: string): void;
}

export function BrowserPanel({
  profiles,
  selectedProfileId,
  disabled,
  url,
  onUrlChange,
  onNavigate,
  onSelectProfile,
}: BrowserPanelProps) {
  const { t } = useI18n();
  return (
    <section className="browser-panel panel">
      <div className="panel-heading">
        <div className="label-with-icon">
          <Monitor size={16} />
          <strong>{t("browserTitle")}</strong>
        </div>
        <Badge tone="success">
          <LockKeyhole size={10} />
          {t("isolatedSession")}
        </Badge>
      </div>
      <div className="profile-strip">
        <span className="profile-orb" />
        <select
          aria-label={t("profile")}
          value={selectedProfileId}
          disabled={disabled}
          onChange={(event) => onSelectProfile(event.target.value)}
        >
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
        <span className="profile-strip__hint">{t("browserDescription")}</span>
      </div>
      <form
        className="address-bar"
        onSubmit={(event) => {
          event.preventDefault();
          onNavigate();
        }}
      >
        <Button tone="ghost" onClick={onNavigate} disabled={disabled} aria-label={t("reload")}>
          <RotateCw size={13} />
        </Button>
        <Globe2 size={12} />
        <input
          aria-label={t("browserAddress")}
          value={url}
          onChange={(event) => onUrlChange(event.target.value)}
          disabled={disabled}
        />
        <button type="submit" className="address-go" disabled={disabled} aria-label={t("navigate")}>
          <ArrowRight size={14} />
        </button>
      </form>
      <BrowserSlot />
    </section>
  );
}
