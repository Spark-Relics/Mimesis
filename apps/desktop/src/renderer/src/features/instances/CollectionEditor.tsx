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
import { SuggestPanel } from "./SuggestPanel";

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
/**
 * Recipe for a TikTok profile page. Every selector is one of TikTok's own
 * `data-e2e` hooks and was checked against a live, logged-out profile page.
 * Each grid card is a single post link that also carries a view counter and a
 * thumbnail image; those three are what this recipe collects. The caption is
 * only present in the thumbnail's `alt` attribute, which the extraction
 * attribute set (text/href/src/value) cannot read, so it is intentionally left
 * out. The grid extends by window infinite scroll (no pagination controls), so
 * scrolling to the bottom loads more cards until none are added or `maxPages`
 * is reached. `missing: "row"` keeps a single lazily-rendered card without data
 * from discarding the whole page.
 */
export const tiktokProfileWorkflow: CollectionWorkflow = {
  ...emptyWorkflow,
  extract: {
    items: '[data-e2e="user-post-item"]',
    missing: "row",
    fields: [
      { name: "videoUrl", selector: "a", attribute: "href", required: true },
      { name: "views", selector: '[data-e2e="video-views"]', attribute: "text", required: false },
      { name: "thumbnail", selector: "img", attribute: "src", required: false },
    ],
  },
  pagination: { scroll: { to: "bottom" }, maxPages: 10 },
  dedupe: ["videoUrl"],
};

/** Serializes request headers to one `Name: value` line each for the editor textarea. */
function headerLines(headers: HttpRequestSpec["headers"]): string {
  return Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

/** Parses `Name: value` lines back into the header record; malformed lines are ignored. */
function parseHeaders(text: string): HttpRequestSpec["headers"] {
  const headers: HttpRequestSpec["headers"] = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (!key) continue;
    headers[key] = line.slice(at + 1).trimStart();
  }
  return headers;
}

/** Type guard: URL-mode pagination addresses each page by a template. */
function isUrlPagination(
  pagination: NonNullable<CollectionWorkflow["pagination"]>,
): pagination is { urlTemplate: string; startPage: number; maxPages: number } {
  return "urlTemplate" in pagination;
}

/** Type guard: cursor-mode pagination extracts the next URL from a response body. */
function isCursorPagination(
  pagination: NonNullable<CollectionWorkflow["pagination"]>,
): pagination is {
  cursor: { request: HttpRequestSpec; pattern: string };
  maxPages: number;
} {
  return "cursor" in pagination;
}

/** Type guard: scroll-mode pagination advances an in-place infinite list. */
function isScrollPagination(
  pagination: NonNullable<CollectionWorkflow["pagination"]>,
): pagination is { scroll: { selector?: string; to: "top" | "bottom" }; maxPages: number } {
  return "scroll" in pagination;
}

function paginationModeValue(pagination: NonNullable<CollectionWorkflow["pagination"]>) {
  if (isUrlPagination(pagination)) return "url";
  if (isCursorPagination(pagination)) return "cursor";
  if (isScrollPagination(pagination)) return "scroll";
  return "click";
}

function UrlPaginationFields({
  pagination,
  disabled,
  onChange,
}: {
  pagination: { urlTemplate: string; startPage: number; maxPages: number };
  disabled: boolean;
  onChange(pagination: CollectionWorkflow["pagination"]): void;
}) {
  const { t } = useI18n();
  return (
    <div className="workflow-form-row">
      <label className="workflow-field">
        {t("flowPageUrl")}
        <input
          value={pagination.urlTemplate}
          disabled={disabled}
          placeholder={t("flowPageUrlExample")}
          onChange={(event) => onChange({ ...pagination, urlTemplate: event.target.value })}
        />
      </label>
      <label className="workflow-field short-field">
        {t("flowStartPage")}
        <input
          type="number"
          min={0}
          max={1000}
          value={pagination.startPage}
          disabled={disabled}
          onChange={(event) => onChange({ ...pagination, startPage: Number(event.target.value) })}
        />
      </label>
    </div>
  );
}

function CursorPaginationFields({
  pagination,
  disabled,
  onChange,
}: {
  pagination: {
    cursor: { request: HttpRequestSpec; pattern: string };
    maxPages: number;
  };
  disabled: boolean;
  onChange(pagination: CollectionWorkflow["pagination"]): void;
}) {
  const { t } = useI18n();
  return (
    <div className="workflow-form-row">
      <label className="workflow-field">
        {t("flowCursorUrl")}
        <input
          value={pagination.cursor.request.url}
          disabled={disabled}
          placeholder={t("flowCursorUrlExample")}
          onChange={(event) =>
            onChange({
              ...pagination,
              cursor: {
                ...pagination.cursor,
                request: { ...pagination.cursor.request, url: event.target.value },
              },
            })
          }
        />
      </label>
      <label className="workflow-field">
        {t("flowCursorPattern")}
        <input
          value={pagination.cursor.pattern}
          disabled={disabled}
          placeholder={t("flowCursorPatternExample")}
          onChange={(event) =>
            onChange({
              ...pagination,
              cursor: { ...pagination.cursor, pattern: event.target.value },
            })
          }
        />
      </label>
    </div>
  );
}

function ScrollPaginationFields({
  pagination,
  disabled,
  onChange,
}: {
  pagination: { scroll: { selector?: string; to: "top" | "bottom" }; maxPages: number };
  disabled: boolean;
  onChange(pagination: CollectionWorkflow["pagination"]): void;
}) {
  const { t } = useI18n();
  return (
    <div className="workflow-form-row">
      <label className="workflow-field">
        {t("flowScrollTarget")}
        <input
          value={pagination.scroll.selector ?? ""}
          disabled={disabled}
          placeholder={t("flowScrollTargetExample")}
          onChange={(event) =>
            onChange({
              ...pagination,
              scroll: {
                ...pagination.scroll,
                // An empty selector means "scroll the window", so the key is dropped.
                selector: event.target.value || undefined,
              },
            })
          }
        />
      </label>
      <label className="workflow-field short-field">
        {t("flowScrollDirection")}
        <select
          value={pagination.scroll.to}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              ...pagination,
              scroll: { ...pagination.scroll, to: event.target.value as "top" | "bottom" },
            })
          }
        >
          <option value="bottom">{t("flowScrollBottom")}</option>
          <option value="top">{t("flowScrollTop")}</option>
        </select>
      </label>
    </div>
  );
}

function ClickPaginationFields({
  pagination,
  disabled,
  onChange,
}: {
  pagination: { next: string; maxPages: number };
  disabled: boolean;
  onChange(pagination: CollectionWorkflow["pagination"]): void;
}) {
  const { t } = useI18n();
  return (
    <div className="workflow-form-row">
      <label className="workflow-field">
        {t("flowNext")}
        <input
          value={pagination.next}
          disabled={disabled}
          placeholder={t("flowNextExample")}
          onChange={(event) => onChange({ ...pagination, next: event.target.value })}
        />
      </label>
    </div>
  );
}

export function CollectionEditor({
  workflow,
  onChange,
  disabled,
  url,
}: {
  workflow: CollectionWorkflow;
  onChange(value: CollectionWorkflow): void;
  disabled: boolean;
  /** Page the built-in browser shows; proposals are read from it. */
  url: string;
}) {
  const { t } = useI18n();
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const [, setMessage] = useState("");
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
  function toggleSource(key: "url" | "page" | "origin", enabled: boolean) {
    const next: NonNullable<CollectionWorkflow["source"]> = { ...workflow.source };
    if (enabled) next[key] = true;
    else delete next[key];
    const result = { ...workflow };
    // No enabled keys means no provenance, so the key is dropped instead of left empty.
    if (next.url || next.page || next.origin) result.source = next;
    else delete result.source;
    onChange(result);
  }
  function updateMapping(index: number, key: "from" | "to", value: string) {
    setMapping(
      (workflow.mapping ?? []).map((item, at) => {
        if (at === index) return { ...item, [key]: value };
        return item;
      }),
    );
  }
  function setMapping(entries: NonNullable<CollectionWorkflow["mapping"]>) {
    const result = { ...workflow };
    // An empty list means "no mapping", so the key is dropped to keep the digest unchanged.
    if (entries.length) result.mapping = entries;
    else delete result.mapping;
    onChange(result);
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
                  <input
                    type="number"
                    min={0}
                    max={5}
                    aria-label={t("flowRequestRetries")}
                    placeholder={t("flowRequestRetriesPlaceholder")}
                    value={entry.request.retries ?? 0}
                    disabled={disabled}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      const request = { ...entry.request };
                      // Zero means "no retry"; the key is dropped to keep the digest unchanged.
                      if (value > 0) request.retries = value;
                      else delete request.retries;
                      action(index, { ...entry, request });
                    }}
                  />
                  <input
                    type="number"
                    min={0}
                    max={10000}
                    aria-label={t("flowRequestRetryDelay")}
                    placeholder={t("flowRequestRetryDelayPlaceholder")}
                    value={entry.request.retryDelayMs ?? 500}
                    disabled={disabled}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      const request = { ...entry.request };
                      // The default backoff is omitted from the workflow to keep digests stable.
                      if (value === 500) delete request.retryDelayMs;
                      else request.retryDelayMs = value;
                      action(index, { ...entry, request });
                    }}
                  />
                  <label className="workflow-check">
                    <input
                      type="checkbox"
                      checked={entry.request.useSession === true}
                      disabled={disabled}
                      onChange={(event) => {
                        const request = { ...entry.request };
                        // Unchecked drops the key so isolated requests keep their old digest.
                        if (event.target.checked) request.useSession = true;
                        else delete request.useSession;
                        action(index, { ...entry, request });
                      }}
                    />
                    <span>{t("flowRequestUseSession")}</span>
                  </label>
                  <textarea
                    aria-label={t("flowRequestHeaders")}
                    placeholder={t("flowRequestHeadersPlaceholder")}
                    spellCheck={false}
                    value={headerLines(entry.request.headers)}
                    disabled={disabled}
                    onChange={(event) =>
                      action(index, {
                        ...entry,
                        request: { ...entry.request, headers: parseHeaders(event.target.value) },
                      })
                    }
                  />
                  <textarea
                    aria-label={t("flowRequestBody")}
                    placeholder={t("flowRequestBodyPlaceholder")}
                    spellCheck={false}
                    value={entry.request.body ?? ""}
                    disabled={disabled}
                    onChange={(event) => {
                      const body = event.target.value;
                      const request = { ...entry.request };
                      // An empty body means "no body"; the key is dropped to keep the digest unchanged.
                      if (body === "") delete request.body;
                      else request.body = body;
                      action(index, { ...entry, request });
                    }}
                  />
                </div>
              )}
              {entry.kind !== "request" && (
                <input
                  aria-label={t("flowSelector")}
                  value={entry.selector ?? ""}
                  disabled={disabled}
                  onChange={(event) => {
                    const selector = event.target.value;
                    // A scroll action's selector is optional; empty means scroll the window.
                    if (entry.kind === "scroll") {
                      action(index, { ...entry, selector: selector || undefined });
                      return;
                    }
                    action(index, { ...entry, selector });
                  }}
                />
              )}
              {entry.kind === "scroll" && (
                <select
                  aria-label={t("flowScrollDirection")}
                  value={entry.to}
                  disabled={disabled}
                  onChange={(event) => {
                    const to = event.target.value as "top" | "bottom";
                    // The selector names the container to scroll; direction is independent of it.
                    action(index, { ...entry, to });
                  }}
                >
                  <option value="bottom">{t("flowScrollBottom")}</option>
                  <option value="top">{t("flowScrollTop")}</option>
                </select>
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
          {(["click", "fill", "wait", "scroll", "request"] as const).map((kind) => (
            <Button
              key={kind}
              disabled={disabled || workflow.before.length >= 20}
              onClick={() => {
                let entry: WorkflowAction = { kind: "click", selector: "" };
                if (kind === "fill") entry = { kind, selector: "", value: "" };
                if (kind === "wait") entry = { kind, selector: "" };
                if (kind === "scroll") entry = { kind: "scroll", to: "bottom" };
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
        <SuggestPanel
          disabled={disabled}
          url={url}
          onApply={(next) => {
            const existing = new Set(workflow.extract.fields.map((field) => field.name));
            const kept = next.fields
              .filter((field) => !existing.has(field.name))
              .map((field) => ({
                name: field.name,
                selector: field.selector,
                attribute: field.attribute as "text" | "href" | "src" | "value",
                required: false,
              }));
            const applied: CollectionWorkflow = {
              ...workflow,
              extract: {
                items: next.items,
                fields: [...workflow.extract.fields, ...kept],
              },
            };
            // A proposed next-page selector only replaces an empty loop.
            if (next.pagination && !workflow.pagination)
              applied.pagination = { next: next.pagination, maxPages: 10 };
            onChange(applied);
            setMessage(t("suggestApplied"));
          }}
        />
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
          <>
            <div className="workflow-form-row">
              <label className="workflow-field">
                {t("flowPaginationMode")}
                <select
                  value={paginationModeValue(workflow.pagination)}
                  disabled={disabled}
                  onChange={(event) => {
                    if (!workflow.pagination) return;
                    let pagination: CollectionWorkflow["pagination"];
                    if (event.target.value === "url")
                      pagination = {
                        urlTemplate: "https://example.com/list?page={{page}}",
                        startPage: 1,
                        maxPages: workflow.pagination.maxPages,
                      };
                    else if (event.target.value === "cursor")
                      pagination = {
                        cursor: {
                          request: {
                            method: "GET",
                            url: "https://api.example.com/page",
                            headers: {},
                            timeoutMs: 5000,
                            expectStatus: 200,
                          },
                          pattern: "next=(\\S+)",
                        },
                        maxPages: workflow.pagination.maxPages,
                      };
                    else if (event.target.value === "scroll")
                      pagination = {
                        scroll: { to: "bottom" },
                        maxPages: workflow.pagination.maxPages,
                      };
                    else pagination = { next: "", maxPages: workflow.pagination.maxPages };
                    onChange({ ...workflow, pagination });
                  }}
                >
                  <option value="click">{t("flowPaginationClick")}</option>
                  <option value="url">{t("flowPaginationUrl")}</option>
                  <option value="cursor">{t("flowPaginationCursor")}</option>
                  <option value="scroll">{t("flowPaginationScroll")}</option>
                </select>
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
                        pagination: {
                          ...workflow.pagination,
                          maxPages: Number(event.target.value),
                        },
                      });
                  }}
                />
              </label>
            </div>
            {paginationModeValue(workflow.pagination) === "url" &&
              isUrlPagination(workflow.pagination) && (
                <UrlPaginationFields
                  pagination={workflow.pagination}
                  disabled={disabled}
                  onChange={(pagination) => onChange({ ...workflow, pagination })}
                />
              )}
            {paginationModeValue(workflow.pagination) === "cursor" &&
              isCursorPagination(workflow.pagination) && (
                <CursorPaginationFields
                  pagination={workflow.pagination}
                  disabled={disabled}
                  onChange={(pagination) => onChange({ ...workflow, pagination })}
                />
              )}
            {paginationModeValue(workflow.pagination) === "scroll" &&
              isScrollPagination(workflow.pagination) && (
                <ScrollPaginationFields
                  pagination={workflow.pagination}
                  disabled={disabled}
                  onChange={(pagination) => onChange({ ...workflow, pagination })}
                />
              )}
            {paginationModeValue(workflow.pagination) === "click" && (
              <ClickPaginationFields
                pagination={workflow.pagination as { next: string; maxPages: number }}
                disabled={disabled}
                onChange={(pagination) => onChange({ ...workflow, pagination })}
              />
            )}
          </>
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
        <p className="workflow-hint">{t("flowSourceInfo")}</p>
        <div className="workflow-form-row">
          <label className="workflow-check">
            <input
              type="checkbox"
              checked={Boolean(workflow.source?.url)}
              disabled={disabled}
              onChange={(event) => toggleSource("url", event.target.checked)}
            />
            {t("flowSourceUrl")}
          </label>
          <label className="workflow-check">
            <input
              type="checkbox"
              checked={Boolean(workflow.source?.page)}
              disabled={disabled}
              onChange={(event) => toggleSource("page", event.target.checked)}
            />
            {t("flowSourcePage")}
          </label>
          <label className="workflow-check">
            <input
              type="checkbox"
              checked={Boolean(workflow.source?.origin)}
              disabled={disabled}
              onChange={(event) => toggleSource("origin", event.target.checked)}
            />
            {t("flowSourceOrigin")}
          </label>
        </div>
        <p className="workflow-hint">{t("flowSourceInfoHint")}</p>
        <p className="workflow-hint">{t("flowMappingInfo")}</p>
        {(workflow.mapping ?? []).map((entry, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: mapping rows are controlled and have no stable identity in the executable schema.
          <div className="workflow-form-row" key={`mapping-${index}`}>
            <label className="workflow-field">
              {t("flowMappingFrom")}
              <input
                value={entry.from}
                disabled={disabled}
                placeholder={t("flowMappingFromPlaceholder")}
                onChange={(event) => updateMapping(index, "from", event.target.value)}
              />
            </label>
            <label className="workflow-field">
              {t("flowMappingTo")}
              <input
                value={entry.to}
                disabled={disabled}
                placeholder={t("flowMappingToPlaceholder")}
                onChange={(event) => updateMapping(index, "to", event.target.value)}
              />
            </label>
            <Button
              tone="ghost"
              aria-label={t("flowRemove")}
              disabled={disabled}
              onClick={() =>
                setMapping((workflow.mapping ?? []).filter((_entry, at) => at !== index))
              }
            >
              <Trash2 size={14} />
            </Button>
          </div>
        ))}
        <Button
          disabled={disabled || (workflow.mapping?.length ?? 0) >= 64}
          onClick={() => setMapping([...(workflow.mapping ?? []), { from: "", to: "" }])}
        >
          <Plus size={13} />
          {t("flowMappingAdd")}
        </Button>
        <p className="workflow-hint">{t("flowMappingInfoHint")}</p>
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
