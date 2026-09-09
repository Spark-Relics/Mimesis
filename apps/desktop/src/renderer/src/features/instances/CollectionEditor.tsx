import {
  type CollectionWorkflow,
  collectionWorkflowSchema,
  type WorkflowAction,
} from "@clawler/contracts";
import { useI18n } from "@clawler/i18n";
import { Button } from "@clawler/ui";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { stepKeys } from "../../shared/presentation";

export const emptyWorkflow: CollectionWorkflow = {
  version: 1,
  before: [],
  extract: {
    items: "",
    fields: [{ name: "title", selector: "", attribute: "text", required: true }],
  },
  pagination: null,
  waitTimeoutMs: 8000,
  maxRecords: 1000,
};
export const quotesWorkflow: CollectionWorkflow = {
  ...emptyWorkflow,
  extract: {
    items: ".quote",
    fields: [
      { name: "quote", selector: ".text", attribute: "text", required: true },
      { name: "author", selector: ".author", attribute: "text", required: true },
    ],
  },
  pagination: { next: ".next a", maxPages: 2 },
};

export function CollectionEditor({
  workflow,
  onChange,
  disabled,
}: {
  workflow: CollectionWorkflow;
  onChange(value: CollectionWorkflow): void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  function action(index: number, next: WorkflowAction) {
    onChange({
      ...workflow,
      before: workflow.before.map((entry, at) => {
        if (at === index) return next;
        return entry;
      }),
    });
  }
  function move(index: number, offset: number) {
    const before = [...workflow.before];
    const entry = before.splice(index, 1)[0];
    if (entry) before.splice(index + offset, 0, entry);
    onChange({ ...workflow, before });
  }
  return (
    <div className="collection-editor">
      <section className="workflow-section">
        <div className="workflow-section-title">
          <span>{"01"}</span>
          <div>
            <h2>{t("flowBefore")}</h2>
            <p>{t("flowBeforeHint")}</p>
          </div>
        </div>
        {!workflow.before.length && <p className="workflow-muted">{t("flowNoActions")}</p>}
        <ol className="recorded-actions">
          {workflow.before.map((entry, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: These controlled inputs represent ordered script slots and hold no row-local state.
            <li key={`action-${index}-${entry.kind}`}>
              <span className="action-number">{index + 1}</span>
              <strong>{t(stepKeys[entry.kind])}</strong>
              <input
                aria-label={t("flowSelector")}
                value={entry.selector}
                disabled={disabled}
                onChange={(event) => action(index, { ...entry, selector: event.target.value })}
              />
              {entry.kind === "fill" && (
                <input
                  aria-label={t("flowValue")}
                  value={entry.value}
                  disabled={disabled}
                  onChange={(event) => action(index, { ...entry, value: event.target.value })}
                />
              )}
              <Button
                tone="ghost"
                aria-label={t("flowMoveUp")}
                disabled={disabled || index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp size={14} />
              </Button>
              <Button
                tone="ghost"
                aria-label={t("flowMoveDown")}
                disabled={disabled || index === workflow.before.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown size={14} />
              </Button>
              <Button
                tone="ghost"
                aria-label={t("flowRemove")}
                disabled={disabled}
                onClick={() =>
                  onChange({
                    ...workflow,
                    before: workflow.before.filter((_entry, at) => at !== index),
                  })
                }
              >
                <Trash2 size={14} />
              </Button>
            </li>
          ))}
        </ol>
        <div className="workflow-actions">
          {(["click", "fill", "wait"] as const).map((kind) => (
            <Button
              key={kind}
              disabled={disabled || workflow.before.length >= 20}
              onClick={() => {
                let entry: WorkflowAction = { kind: "click", selector: "" };
                if (kind === "fill") entry = { kind, selector: "", value: "" };
                if (kind === "wait") entry = { kind, selector: "" };
                onChange({ ...workflow, before: [...workflow.before, entry] });
              }}
            >
              <Plus size={13} />
              {t(stepKeys[kind])}
            </Button>
          ))}
        </div>
      </section>
      <section className="workflow-section">
        <div className="workflow-section-title">
          <span>{"02"}</span>
          <div>
            <h2>{t("flowExtract")}</h2>
            <p>{t("flowExtractHint")}</p>
          </div>
        </div>
        <label className="workflow-field">
          {t("flowItems")}
          <input
            value={workflow.extract.items}
            placeholder={t("flowItemsExample")}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...workflow, extract: { ...workflow.extract, items: event.target.value } })
            }
          />
        </label>
        <div className="extraction-fields">
          <div className="extraction-head">
            <span>{t("flowFieldName")}</span>
            <span>{t("flowFieldSelector")}</span>
            <span>{t("flowAttribute")}</span>
            <span>{t("flowRequired")}</span>
          </div>
          {workflow.extract.fields.map((field, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: Controlled fields have editable names and no stable identity in the executable schema.
            <div className="extraction-row" key={`field-${index}`}>
              <input
                aria-label={t("flowFieldName")}
                value={field.name}
                disabled={disabled}
                onChange={(event) =>
                  onChange({
                    ...workflow,
                    extract: {
                      ...workflow.extract,
                      fields: workflow.extract.fields.map((entry, at) => {
                        if (at === index) return { ...entry, name: event.target.value };
                        return entry;
                      }),
                    },
                  })
                }
              />
              <input
                aria-label={t("flowFieldSelector")}
                value={field.selector}
                placeholder={t("flowFieldExample")}
                disabled={disabled}
                onChange={(event) =>
                  onChange({
                    ...workflow,
                    extract: {
                      ...workflow.extract,
                      fields: workflow.extract.fields.map((entry, at) => {
                        if (at === index) return { ...entry, selector: event.target.value };
                        return entry;
                      }),
                    },
                  })
                }
              />
              <select
                aria-label={t("flowAttribute")}
                value={field.attribute}
                disabled={disabled}
                onChange={(event) => {
                  const attribute = event.target.value as typeof field.attribute;
                  onChange({
                    ...workflow,
                    extract: {
                      ...workflow.extract,
                      fields: workflow.extract.fields.map((entry, at) => {
                        if (at === index) return { ...entry, attribute };
                        return entry;
                      }),
                    },
                  });
                }}
              >
                {(["text", "href", "src", "value"] as const).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <input
                type="checkbox"
                aria-label={t("flowRequired")}
                checked={field.required}
                disabled={disabled}
                onChange={(event) =>
                  onChange({
                    ...workflow,
                    extract: {
                      ...workflow.extract,
                      fields: workflow.extract.fields.map((entry, at) => {
                        if (at === index) return { ...entry, required: event.target.checked };
                        return entry;
                      }),
                    },
                  })
                }
              />
              <Button
                tone="ghost"
                aria-label={t("flowRemove")}
                disabled={disabled || workflow.extract.fields.length <= 1}
                onClick={() =>
                  onChange({
                    ...workflow,
                    extract: {
                      ...workflow.extract,
                      fields: workflow.extract.fields.filter((_entry, at) => at !== index),
                    },
                  })
                }
              >
                <Trash2 size={14} />
              </Button>
            </div>
          ))}
        </div>
        <Button
          disabled={disabled || workflow.extract.fields.length >= 20}
          onClick={() =>
            onChange({
              ...workflow,
              extract: {
                ...workflow.extract,
                fields: [
                  ...workflow.extract.fields,
                  {
                    name: `field${workflow.extract.fields.length + 1}`,
                    selector: "",
                    attribute: "text",
                    required: false,
                  },
                ],
              },
            })
          }
        >
          <Plus size={13} />
          {t("flowAddField")}
        </Button>
      </section>
      <section className="workflow-section loop-section">
        <div className="workflow-section-title">
          <span>{"03"}</span>
          <div>
            <h2>{t("flowLoop")}</h2>
            <p>{t("flowLoopHint")}</p>
          </div>
        </div>
        <label className="workflow-check">
          <input
            type="checkbox"
            checked={Boolean(workflow.pagination)}
            disabled={disabled}
            onChange={(event) => {
              let pagination: CollectionWorkflow["pagination"] = null;
              if (event.target.checked) pagination = { next: "", maxPages: 10 };
              onChange({ ...workflow, pagination });
            }}
          />
          {t("flowEnableLoop")}
        </label>
        {workflow.pagination && (
          <div className="workflow-form-row">
            <label className="workflow-field">
              {t("flowNext")}
              <input
                value={workflow.pagination.next}
                disabled={disabled}
                placeholder={t("flowNextExample")}
                onChange={(event) => {
                  if (workflow.pagination)
                    onChange({
                      ...workflow,
                      pagination: { ...workflow.pagination, next: event.target.value },
                    });
                }}
              />
            </label>
            <label className="workflow-field short-field">
              {t("flowMaxPages")}
              <input
                type="number"
                min={1}
                max={50}
                value={workflow.pagination.maxPages}
                disabled={disabled}
                onChange={(event) => {
                  if (workflow.pagination)
                    onChange({
                      ...workflow,
                      pagination: { ...workflow.pagination, maxPages: Number(event.target.value) },
                    });
                }}
              />
            </label>
          </div>
        )}
        <div className="workflow-form-row">
          <label className="workflow-field">
            {t("flowTimeout")}
            <input
              type="number"
              min={100}
              max={15000}
              value={workflow.waitTimeoutMs}
              disabled={disabled}
              onChange={(event) =>
                onChange({ ...workflow, waitTimeoutMs: Number(event.target.value) })
              }
            />
          </label>
          <label className="workflow-field">
            {t("flowMaxRecords")}
            <input
              type="number"
              min={1}
              max={2000}
              value={workflow.maxRecords}
              disabled={disabled}
              onChange={(event) =>
                onChange({ ...workflow, maxRecords: Number(event.target.value) })
              }
            />
          </label>
        </div>
      </section>
      <details
        className="workflow-section"
        onToggle={(event) => {
          if (event.currentTarget.open) setSource(JSON.stringify(workflow, null, 2));
        }}
      >
        <summary>{t("flowSource")}</summary>
        <p className="workflow-muted">{t("flowSourceHint")}</p>
        <textarea
          className="workflow-source"
          spellCheck={false}
          aria-label={t("flowSource")}
          value={source}
          disabled={disabled}
          onChange={(event) => setSource(event.target.value)}
        />
        <Button
          disabled={disabled}
          onClick={() => {
            try {
              onChange(collectionWorkflowSchema.parse(JSON.parse(source)));
              setError("");
            } catch {
              setError(t("flowInvalidScript"));
            }
          }}
        >
          {t("flowApplySource")}
        </Button>
        {error && <p role="alert">{error}</p>}
      </details>
    </div>
  );
}
