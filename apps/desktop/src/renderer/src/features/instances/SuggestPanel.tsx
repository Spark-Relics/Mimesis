import type { PageStructure } from "@clawler/contracts";
import { useI18n } from "@clawler/i18n";
import { Button } from "@clawler/ui";
import { ScanSearch, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { bridge } from "../../platform/bridge";

/**
 * Deterministic page reading: the application proposes list/field/pagination
 * candidates and the user confirms them. This closes the "any website" gap
 * without a model — the user points, the app fills in the selectors.
 */
export function SuggestPanel({
  disabled,
  url,
  onApply,
}: {
  disabled: boolean;
  /** The page the built-in browser currently shows; candidates are read from it. */
  url: string;
  onApply(next: {
    items: string;
    fields: Array<{ name: string; selector: string; attribute: string }>;
    pagination?: string | null;
  }): void;
}) {
  const { t } = useI18n();
  const [structure, setStructure] = useState<PageStructure | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pickedList, setPickedList] = useState(0);
  const [pickedFields, setPickedFields] = useState<Set<string>>(new Set());
  const [pickedPagination, setPickedPagination] = useState<string | null>(null);

  // Live highlight follows the cursor's focus, so the user sees the match first.
  useEffect(() => {
    if (disabled) return;
    const list = structure?.lists[pickedList];
    const target = list?.itemSelector ?? "";
    if (!target) return;
    // Preview failures stay silent: the panel still works with a stale outline.
    void bridge.highlight(target).catch(() => undefined);
    return () => {
      void bridge.clearHighlight().catch(() => undefined);
    };
  }, [structure, pickedList, disabled]);

  async function scan() {
    setBusy(true);
    setError("");
    try {
      const result = await bridge.observePage(url);
      setStructure(result);
      setPickedList(0);
      const first = result.lists[0];
      setPickedFields(new Set((first?.fields ?? []).map((field) => field.name)));
      setPickedPagination(result.pagination[0]?.selector ?? null);
      if (!result.lists.length) setError(t("suggestEmpty"));
    } catch {
      setError(t("suggestFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (!structure) {
    return (
      <div className="suggest-panel">
        <div className="suggest-intro">
          <ScanSearch size={15} />
          <div>
            <strong>{t("suggestTitle")}</strong>
            <p>{t("suggestHint")}</p>
          </div>
        </div>
        {error && (
          <p className="workflow-feedback workflow-error" role="alert">
            {error}
          </p>
        )}
        <Button tone="primary" disabled={disabled || busy} onClick={() => void scan()}>
          <Sparkles size={13} />
          {t("suggestScan")}
        </Button>
      </div>
    );
  }

  const list = structure.lists[pickedList];
  const fields = list?.fields ?? [];

  function apply() {
    if (!list) return;
    const chosen = fields.filter((field) => pickedFields.has(field.name));
    onApply({
      // One record per repeated row, not per container: fields resolve within the row.
      items: list.itemSelector,
      fields: chosen.map((field) => ({
        name: field.name,
        selector: field.selector,
        attribute: field.attribute,
      })),
      // null keeps the current loop config; an empty string would clear it.
      pagination: pickedPagination,
    });
  }

  return (
    <div className="suggest-panel">
      <div className="suggest-intro">
        <ScanSearch size={15} />
        <div>
          <strong>{t("suggestTitle")}</strong>
          <p>{t("suggestResultHint")}</p>
        </div>
      </div>
      <div className="suggest-columns">
        <label className="workflow-field">
          {t("suggestLists")}
          <select
            disabled={disabled}
            value={pickedList}
            onChange={(event) => {
              const index = Number(event.target.value);
              setPickedList(index);
              const next = structure.lists[index];
              setPickedFields(new Set((next?.fields ?? []).map((field) => field.name)));
            }}
          >
            {structure.lists.map((entry, index) => (
              <option key={entry.selector} value={index}>
                {`${entry.itemSelector} · ${entry.count} ${t("suggestItemsUnit")}`}
              </option>
            ))}
          </select>
        </label>
        <label className="workflow-field">
          {t("suggestPagination")}
          <select
            disabled={disabled}
            value={pickedPagination ?? ""}
            onChange={(event) => setPickedPagination(event.target.value || null)}
          >
            <option value="">{t("suggestNoPagination")}</option>
            {structure.pagination.map((entry) => (
              <option key={entry.selector} value={entry.selector}>
                {`${entry.label} · ${entry.selector}`}
              </option>
            ))}
          </select>
        </label>
      </div>
      {fields.length > 0 && (
        <ul className="suggest-fields">
          {fields.map((field) => {
            const checked = pickedFields.has(field.name);
            return (
              <li key={`${field.name}-${field.selector}`}>
                <label className="workflow-check">
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={checked}
                    onChange={(event) => {
                      const next = new Set(pickedFields);
                      if (event.target.checked) next.add(field.name);
                      else next.delete(field.name);
                      setPickedFields(next);
                    }}
                  />
                  <span className="suggest-field-name">{field.name}</span>
                  <span className="suggest-field-selector">
                    {field.selector || t("suggestItemItself")}
                  </span>
                  <span className="suggest-field-attribute">{field.attribute}</span>
                </label>
                {field.samples.length > 0 && (
                  <span className="suggest-samples">
                    {field.samples.filter(Boolean).join(" · ").slice(0, 120)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {fields.length === 0 && <p className="workflow-muted">{t("suggestNoFields")}</p>}
      {error && (
        <p className="workflow-feedback workflow-error" role="alert">
          {error}
        </p>
      )}
      <div className="workflow-actions">
        <Button disabled={disabled || busy} onClick={() => void scan()}>
          {t("suggestRescan")}
        </Button>
        <Button
          tone="primary"
          disabled={disabled || !list || pickedFields.size === 0}
          onClick={() => apply()}
        >
          {t("suggestApply")}
        </Button>
      </div>
    </div>
  );
}
