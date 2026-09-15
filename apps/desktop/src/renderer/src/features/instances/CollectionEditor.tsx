import {
  type CollectionWorkflow,
  collectionWorkflowSchema,
  type DetailTraversal,
  type Extraction,
  type HttpRequestSpec,
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
  dedupe: [],
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
  // Detail traversal stays a single source of truth for both the toggle and its inputs.
  const detail = workflow.detail;
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
              {entry.kind === "request" && (
                <div className="request-fields">
                  <select
                    aria-label={t("flowRequestMethod")}
                    value={entry.request.method}
                    disabled={disabled}
                    onChange={(event) =>
                      action(index, {
                        ...entry,
                        request: {
                          ...entry.request,
                          method: event.target.value as HttpRequestSpec["method"],
                        },
                      })
                    }
                  >
                    {(["GET", "POST", "PUT", "PATCH", "DELETE"] as const).map((method) => (
                      <option key={method} value={method}>
                        {method}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label={t("flowRequestUrl")}
                    placeholder={t("flowRequestUrlPlaceholder")}
                    value={entry.request.url}
                    disabled={disabled}
                    onChange={(event) =>
                      action(index, {
                        ...entry,
                        request: { ...entry.request, url: event.target.value },
                      })
                    }
                  />
                  <input
                    aria-label={t("flowRequestCapture")}
                    placeholder={t("flowRequestCapturePlaceholder")}
                    value={entry.request.capture?.name ?? ""}
                    disabled={disabled}
                    onChange={(event) => {
                      // Empty means "do not capture"; the capture block is dropped.
                      const name = event.target.value;
                      if (!name) {
                        action(index, {
                          ...entry,
                          request: { ...entry.request, capture: undefined },
                        });
                        return;
                      }
                      action(index, {
                        ...entry,
                        request: { ...entry.request, capture: { name, maxLength: 64000 } },
                      });
                    }}
                  />
                </div>
              )}
              {entry.kind !== "request" && (
                <input
                  aria-label={t("flowSelector")}
                  value={entry.selector}
                  disabled={disabled}
                  onChange={(event) => action(index, { ...entry, selector: event.target.value })}
                />
              )}
              <input
                aria-label={t("flowCondition")}
                placeholder={t("flowConditionPlaceholder")}
                value={entry.when?.exists ?? ""}
                disabled={disabled}
                onChange={(event) => {
                  // An empty field means "always run", so the condition is dropped rather than left invalid.
                  const condition = event.target.value;
                  if (!condition) {
                    action(index, { ...entry, when: undefined });
                    return;
                  }
                  action(index, { ...entry, when: { exists: condition } });
                }}
              />
              <label className="workflow-check action-error">
                <input
                  type="checkbox"
                  aria-label={t("flowOnError")}
                  checked={entry.onError === "skip"}
                  disabled={disabled}
                  onChange={(event) => {
                    // Unchecking drops the branch so the default `fail` behaviour is stored.
                    if (event.target.checked) action(index, { ...entry, onError: "skip" });
                    else action(index, { ...entry, onError: undefined });
                  }}
                />
                {t("flowOnError")}
              </label>
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
          {(["click", "fill", "wait", "request"] as const).map((kind) => (
            <Button
              key={kind}
              disabled={disabled || workflow.before.length >= 20}
              onClick={() => {
                let entry: WorkflowAction = { kind: "click", selector: "" };
                if (kind === "fill") entry = { kind, selector: "", value: "" };
                if (kind === "wait") entry = { kind, selector: "" };
                if (kind === "request")
                  entry = {
                    kind,
                    request: {
                      method: "GET",
                      url: "",
                      headers: {},
                      timeoutMs: 10000,
                      expectStatus: 200,
                    },
                  };
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
        <MissingPolicySelect
          extraction={workflow.extract}
          disabled={disabled}
          onChange={(extract) => onChange({ ...workflow, extract })}
        />
        <ExtractionFields
          fields={workflow.extract.fields}
          disabled={disabled}
          onChange={(fields) => onChange({ ...workflow, extract: { ...workflow.extract, fields } })}
        />
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
        <div className="workflow-form-row">
          <label className="workflow-field">
            {t("flowDedupe")}
            <input
              value={(workflow.dedupe ?? []).join(",")}
              disabled={disabled}
              placeholder={t("flowDedupe")}
              onChange={(event) =>
                onChange({
                  ...workflow,
                  dedupe: event.target.value
                    .split(",")
                    .map((name) => name.trim())
                    .filter(Boolean)
                    .slice(0, 8),
                })
              }
            />
          </label>
        </div>
        <div className="workflow-form-row">
          <label className="workflow-field">
            {t("flowWatermark")}
            <input
              value={workflow.watermark?.field ?? ""}
              disabled={disabled}
              placeholder={t("flowWatermark")}
              onChange={(event) => {
                const value = event.target.value.trim();
                const next = { ...workflow };
                // An empty field means "no incremental watermark", so the key is dropped.
                if (value === "") delete next.watermark;
                else next.watermark = { field: value };
                onChange(next);
              }}
            />
            <span className="workflow-hint">{t("flowWatermarkHint")}</span>
          </label>
          <label className="workflow-field">
            {t("flowFilter")}
            <input
              value={workflow.filter ?? ""}
              disabled={disabled}
              placeholder={t("flowFilter")}
              onChange={(event) => {
                const value = event.target.value.trim();
                const next = { ...workflow };
                if (value === "") delete next.filter;
                else next.filter = event.target.value;
                onChange(next);
              }}
            />
            <span className="workflow-hint">{t("flowFilterHint")}</span>
          </label>
        </div>
      </section>
      <section className="workflow-section">
        <div className="workflow-section-title">
          <span>{"04"}</span>
          <div>
            <h2>{t("flowDetail")}</h2>
            <p>{t("flowDetailHint")}</p>
          </div>
        </div>
        <label className="workflow-check">
          <input
            type="checkbox"
            checked={Boolean(detail)}
            disabled={disabled}
            onChange={(event) => {
              let next: CollectionWorkflow["detail"];
              if (event.target.checked)
                next = {
                  link: "",
                  extract: {
                    items: "",
                    fields: [{ name: "detail", selector: "", attribute: "text", required: false }],
                  },
                  maxItems: 10,
                };
              onChange({ ...workflow, detail: next });
            }}
          />
          {t("flowEnableDetail")}
        </label>
        {detail && (
          <TraversalEditor
            depth={1}
            node={detail}
            disabled={disabled}
            onNode={(node) => onChange({ ...workflow, detail: node })}
          />
        )}
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

/**
 * Recursive editor for one traversal level. `depth` bounds the UI to the same three-level
 * nesting limit the workflow schema enforces.
 */
function TraversalEditor({
  depth,
  node,
  disabled,
  onNode,
}: {
  depth: number;
  node: DetailTraversal;
  disabled: boolean;
  onNode(node: DetailTraversal): void;
}) {
  const { t } = useI18n();
  const childDepth = depth + 1;
  return (
    <>
      <div className="workflow-form-row">
        <label className="workflow-field">
          {t("flowDetailLink")}
          <input
            value={node.link}
            disabled={disabled}
            placeholder={t("flowDetailLinkExample")}
            onChange={(event) => onNode({ ...node, link: event.target.value })}
          />
        </label>
        <label className="workflow-field short-field">
          {t("flowDetailMaxItems")}
          <input
            type="number"
            min={1}
            max={500}
            value={node.maxItems}
            disabled={disabled}
            onChange={(event) => onNode({ ...node, maxItems: Number(event.target.value) })}
          />
        </label>
      </div>
      <label className="workflow-field">
        {t("flowDetailItems")}
        <input
          value={node.extract.items}
          disabled={disabled}
          placeholder={t("flowItemsExample")}
          onChange={(event) =>
            onNode({ ...node, extract: { ...node.extract, items: event.target.value } })
          }
        />
      </label>
      <label className="workflow-field">
        {t("flowDetailBack")}
        <input
          value={node.back ?? ""}
          disabled={disabled}
          placeholder={t("flowDetailBackPlaceholder")}
          onChange={(event) => {
            // An empty field means "use browser history", so the key is dropped instead of stored empty.
            const back = event.target.value;
            onNode({ ...node, back: back || undefined });
          }}
        />
      </label>
      <MissingPolicySelect
        extraction={node.extract}
        disabled={disabled}
        onChange={(extract) => onNode({ ...node, extract })}
      />
      <ExtractionFields
        fields={node.extract.fields}
        disabled={disabled}
        onChange={(fields) => onNode({ ...node, extract: { ...node.extract, fields } })}
      />
      <label className="workflow-check">
        <input
          type="checkbox"
          checked={Boolean(node.rows)}
          disabled={disabled}
          onChange={(event) => {
            // Disabling drops both the nested extraction and any child traversal below it.
            if (!event.target.checked) {
              onNode({ ...node, rows: undefined, children: undefined });
              return;
            }
            onNode({
              ...node,
              rows: {
                items: "",
                fields: [{ name: "sku", selector: "", attribute: "text", required: true }],
              },
            });
          }}
        />
        {t("flowRows")}
      </label>
      <p className="workflow-muted">{t("flowRowsHint")}</p>
      {node.rows && (
        <>
          <RowsEditor
            rows={node.rows}
            disabled={disabled}
            onChange={(rows) => onNode({ ...node, rows })}
          />
          {childDepth <= 3 && (
            <>
              <label className="workflow-check">
                <input
                  type="checkbox"
                  checked={Boolean(node.children)}
                  disabled={disabled}
                  onChange={(event) => {
                    if (!event.target.checked) {
                      onNode({ ...node, children: undefined });
                      return;
                    }
                    onNode({
                      ...node,
                      children: {
                        link: "",
                        extract: {
                          items: "",
                          fields: [
                            { name: "value", selector: "", attribute: "text", required: false },
                          ],
                        },
                        maxItems: 10,
                      },
                    });
                  }}
                />
                {t("flowChildren")}
              </label>
              <p className="workflow-muted">{t("flowChildrenHint")}</p>
              {node.children && (
                <TraversalEditor
                  depth={childDepth}
                  node={node.children}
                  disabled={disabled}
                  onNode={(child) => onNode({ ...node, children: child })}
                />
              )}
            </>
          )}
        </>
      )}
    </>
  );
}

/** Editor for the nested-row extraction on a detail page. */
/** Shared bad-record policy selector so all three extraction points behave identically. */
function MissingPolicySelect({
  extraction,
  disabled,
  onChange,
}: {
  extraction: Extraction;
  disabled: boolean;
  onChange(extraction: Extraction): void;
}) {
  const { t } = useI18n();
  return (
    <label className="workflow-field">
      {t("flowMissing")}
      <select
        aria-label={t("flowMissing")}
        title={t("flowMissingHint")}
        value={extraction.missing ?? "page"}
        disabled={disabled}
        onChange={(event) => {
          const mode = event.target.value as NonNullable<Extraction["missing"]>;
          // "page" is the historical default; dropping the key keeps old digests identical.
          if (mode === "page") {
            const { missing: _removed, ...rest } = extraction;
            onChange(rest);
          } else {
            onChange({ ...extraction, missing: mode });
          }
        }}
      >
        <option value="page">{t("flowMissingPage")}</option>
        <option value="row">{t("flowMissingRow")}</option>
      </select>
    </label>
  );
}

function RowsEditor({
  rows,
  disabled,
  onChange,
}: {
  rows: Extraction;
  disabled: boolean;
  onChange(rows: Extraction): void;
}) {
  const { t } = useI18n();
  return (
    <>
      <label className="workflow-field">
        {t("flowRowsItems")}
        <input
          value={rows.items}
          disabled={disabled}
          onChange={(event) => onChange({ ...rows, items: event.target.value })}
        />
      </label>
      <MissingPolicySelect extraction={rows} disabled={disabled} onChange={onChange} />
      <ExtractionFields
        fields={rows.fields}
        disabled={disabled}
        onChange={(fields) => onChange({ ...rows, fields })}
      />
    </>
  );
}

/** Shared field editor so list and detail extraction keep identical behaviour and markup. */
function ExtractionFields({
  fields,
  onChange,
  disabled,
}: {
  fields: Extraction["fields"];
  onChange(fields: Extraction["fields"]): void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  function replace(index: number, next: Extraction["fields"][number]) {
    onChange(
      fields.map((entry, at) => {
        if (at === index) return next;
        return entry;
      }),
    );
  }
  return (
    <>
      <div className="extraction-fields">
        <div className="extraction-head">
          <span>{t("flowFieldName")}</span>
          <span>{t("flowFieldSelector")}</span>
          <span>{t("flowAttribute")}</span>
          <span>{t("flowRequired")}</span>
          <span>{t("flowExpression")}</span>
          <span>{t("flowNormalize")}</span>
          <span>{t("flowFieldType")}</span>
        </div>
        {fields.map((field, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Controlled fields have editable names and no stable identity in the executable schema.
          <div className="extraction-row" key={`field-${index}`}>
            <input
              aria-label={t("flowFieldName")}
              value={field.name}
              disabled={disabled}
              onChange={(event) => replace(index, { ...field, name: event.target.value })}
            />
            <input
              aria-label={t("flowFieldSelector")}
              value={field.selector}
              placeholder={t("flowFieldExample")}
              disabled={disabled}
              onChange={(event) => replace(index, { ...field, selector: event.target.value })}
            />
            <select
              aria-label={t("flowAttribute")}
              value={field.attribute}
              disabled={disabled}
              onChange={(event) =>
                replace(index, {
                  ...field,
                  attribute: event.target.value as typeof field.attribute,
                })
              }
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
              onChange={(event) => replace(index, { ...field, required: event.target.checked })}
            />
            <input
              className="field-expression"
              aria-label={t("flowExpression")}
              title={t("flowExpressionHint")}
              placeholder={t("flowExpression")}
              value={field.expression ?? ""}
              disabled={disabled}
              onChange={(event) => {
                if (!event.target.value) {
                  const { expression: _removed, ...rest } = field;
                  replace(index, rest);
                  return;
                }
                replace(index, { ...field, expression: event.target.value });
              }}
            />
            <select
              aria-label={t("flowNormalize")}
              title={t("flowNormalizeHint")}
              value={field.normalize ?? "none"}
              disabled={disabled}
              onChange={(event) => {
                const mode = event.target.value as NonNullable<
                  Extraction["fields"][number]["normalize"]
                >;
                if (mode === "none") {
                  const { normalize: _removed, ...rest } = field;
                  replace(index, rest);
                  return;
                }
                replace(index, { ...field, normalize: mode });
              }}
            >
              {(["none", "trim", "collapse", "upper", "lower"] as const).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <select
              aria-label={t("flowFieldType")}
              title={t("flowFieldTypeHint")}
              value={field.type ?? "string"}
              disabled={disabled}
              onChange={(event) => {
                const mode = event.target.value as NonNullable<
                  Extraction["fields"][number]["type"]
                >;
                if (mode === "string") {
                  const { type: _removed, ...rest } = field;
                  replace(index, rest);
                  return;
                }
                replace(index, { ...field, type: mode });
              }}
            >
              {(["string", "number", "boolean"] as const).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <Button
              tone="ghost"
              aria-label={t("flowRemove")}
              disabled={disabled || fields.length <= 1}
              onClick={() => onChange(fields.filter((_entry, at) => at !== index))}
            >
              <Trash2 size={14} />
            </Button>
          </div>
        ))}
      </div>
      <Button
        disabled={disabled || fields.length >= 20}
        onClick={() =>
          onChange([
            ...fields,
            {
              name: `field${fields.length + 1}`,
              selector: "",
              attribute: "text",
              required: false,
            },
          ])
        }
      >
        <Plus size={13} />
        {t("flowAddField")}
      </Button>
    </>
  );
}
