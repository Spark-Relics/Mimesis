import type { HttpRequestSpec } from "@clawler/contracts";
import {
  AppError,
  type CollectionRecord,
  type CollectionWorkflow,
  collectionWorkflowSchema,
  type DocumentSnapshot,
  type Extraction,
  type WorkflowPlan,
  workflowParametersSchema,
  workflowPlanSchema,
} from "@clawler/contracts";
import type { BrowserAutomationPort, ScriptContext, ScriptInput } from "@clawler/script-sdk";
import { evaluateExpression, evaluateFilter } from "./expression.js";
import { dedupeKey, mappedOutputNames, mappingTarget } from "./fields.js";
import { parameterNames, validateForPublish } from "./versions.js";

/** Same placeholder syntax as the version layer: `{{name}}`, `{{page}}`, `{{response:name}}`. */
const placeholder = /\{\{([^{}]*)\}\}/gu;

/** One extracted record; field values become numbers/booleans only when a field declares a type. */
export type CollectionRecordValue = string | number | boolean;
type FieldRow = Record<string, CollectionRecordValue>;

/** Normalizes one field value; `collapse` also squashes inner whitespace runs. */
function normalizeValue(value: string, mode: "trim" | "collapse" | "upper" | "lower"): string {
  if (mode === "upper") return value.toUpperCase();
  if (mode === "lower") return value.toLowerCase();
  if (mode === "collapse") return value.trim().replace(/\s+/gu, " ");
  return value.trim();
}

/** Per-row bad-record gate: with missing:"row" an incomplete record is dropped here, not in the page. */
function dropIncompleteRows(extraction: Extraction, rows: CollectionRecord[]): CollectionRecord[] {
  if (extraction.missing !== "row") return rows;
  return rows.filter((row) =>
    extraction.fields.every((field) => !field.required || row[field.name]),
  );
}

/**
 * Coerces declared field types after expressions: string (default) keeps the value,
 * number requires a finite parse (empty string fails), boolean accepts the literals
 * true/false (case-insensitive) and 1/0. Any failure fails the step with INVALID_INPUT.
 */
function applyTypes(extraction: Extraction, rows: CollectionRecord[]): FieldRow[] {
  const typed = extraction.fields.filter((field) => field.type && field.type !== "string");
  if (!typed.length) return rows;
  return rows.map((row) => {
    const next: FieldRow = { ...row };
    for (const field of typed) {
      const value = row[field.name];
      // Browser extraction yields strings; any non-string only arrives in unit fixtures.
      let raw: string;
      if (typeof value === "string") raw = value;
      else if (value === undefined) raw = "";
      else raw = String(value);
      if (field.type === "number") {
        const parsed = Number(raw);
        if (raw.trim() === "" || !Number.isFinite(parsed)) throw new AppError("INVALID_INPUT");
        next[field.name] = parsed;
      } else if (field.type === "boolean") {
        const text = raw.trim().toLowerCase();
        if (text === "true" || text === "1") next[field.name] = true;
        else if (text === "false" || text === "0") next[field.name] = false;
        else throw new AppError("INVALID_INPUT");
      }
    }
    return next;
  });
}

/** Applies per-field normalization (first) then expression fields (second) in place. */
function applyExpressions(extraction: Extraction, rows: CollectionRecord[]): FieldRow[] {
  const kept = dropIncompleteRows(extraction, rows);
  for (const field of extraction.fields) {
    if (field.normalize && field.normalize !== "none") {
      for (const row of kept) {
        const value = row[field.name];
        // Browser extraction yields strings; any non-string only arrives in unit fixtures.
        if (typeof value === "string") row[field.name] = normalizeValue(value, field.normalize);
      }
    }
    if (!field.expression) continue;
    for (const row of kept) row[field.name] = evaluateExpression(field.expression, row);
  }
  return applyTypes(extraction, kept);
}

export function resolveWorkflow(
  input: CollectionWorkflow,
  parameters: Record<string, string> = {},
  /** Captured response bodies, keyed by capture name. Substitution only; never persisted. */
  captures: Record<string, string> = {},
): CollectionWorkflow {
  const workflow = collectionWorkflowSchema.parse(input);
  const values = workflowParametersSchema.parse(parameters);
  const substitute = (text: string): string =>
    text.replace(/\{\{([a-zA-Z][a-zA-Z0-9_:]*)\}\}/gu, (match, name: string) => {
      if (name.startsWith("response:")) {
        // Runtime reference: substituted at execution time once the capture exists.
        const key = name.slice("response:".length);
        if (Object.hasOwn(captures, key)) return captures[key] ?? "";
        return match;
      }
      if (!Object.hasOwn(values, name)) throw new AppError("INVALID_INPUT");
      return values[name] ?? "";
    });
  const bakeRequest = (spec: HttpRequestSpec): HttpRequestSpec => ({
    ...spec,
    url: substitute(spec.url),
    headers: Object.fromEntries(
      Object.entries(spec.headers).map(([key, value]) => [key, substitute(value)]),
    ),
    ...(spec.body !== undefined && { body: substitute(spec.body) }),
  });
  for (const action of workflow.before) {
    if (action.kind === "fill") action.value = substitute(action.value);
    if (action.kind === "request") action.request = bakeRequest(action.request);
  }
  const templated = workflow.pagination;
  if (templated && "urlTemplate" in templated) {
    // Parameters bake in here; `{{page}}` and `{{response:name}}` stay literal
    // because they only resolve per-page / at runtime.
    const urlTemplate = templated.urlTemplate.replace(
      placeholder,
      (match: string, name: string) => {
        if (name === "page" || name.startsWith("response:")) return match;
        if (!Object.hasOwn(values, name)) throw new AppError("INVALID_INPUT");
        return values[name] ?? "";
      },
    );
    workflow.pagination = { ...templated, urlTemplate };
  }
  if (templated && "cursor" in templated) {
    // Cursor requests run per page; parameters bake in once, response references
    // resolve at execution time. `{{page}}` is not available here — the next URL
    // comes from the response body itself.
    workflow.pagination = {
      ...templated,
      cursor: { ...templated.cursor, request: bakeRequest(templated.cursor.request) },
    };
  }
  return collectionWorkflowSchema.parse(workflow);
}

/** Bounded single-page variant used for dry runs: pagination off, budgets capped. */
export function dryRunWorkflow(input: CollectionWorkflow): CollectionWorkflow {
  const workflow = collectionWorkflowSchema.parse(input);
  return collectionWorkflowSchema.parse({
    ...workflow,
    before: workflow.before,
    pagination: null,
    maxRecords: Math.min(workflow.maxRecords, 20),
    detail: workflow.detail && {
      ...workflow.detail,
      maxItems: Math.min(workflow.detail.maxItems, 3),
    },
  });
}

/** Fixed input/output contract derived from the immutable workflow content. */
export function planWorkflow(input: CollectionWorkflow): WorkflowPlan {
  const workflow = validateForPublish(input);
  const output = mappedOutputNames(workflow);
  if (new Set(output).size !== output.length) throw new AppError("INVALID_INPUT");
  let maxPages = 1;
  if (workflow.pagination) maxPages = workflow.pagination.maxPages;
  let maxItemsPerPage = 1;
  if (workflow.detail) maxItemsPerPage = workflow.detail.maxItems;
  return workflowPlanSchema.parse({
    input: parameterNames(workflow),
    output,
    maxPages,
    maxRecords: workflow.maxRecords,
    maxItemsPerPage,
  });
}

/** Abort-aware delay; rejects with the run's reason when cancelled. */
async function wait(signal: AbortSignal, ms: number): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function pause(signal: AbortSignal): Promise<void> {
  await wait(signal, 150);
}

/** Default backoff between request retries when the workflow does not set one. */
const defaultRetryDelayMs = 500;

/** A configured record filter: falsy results drop the record before dedupe/budget. */
function passesFilter(workflow: CollectionWorkflow, row: FieldRow): boolean {
  if (!workflow.filter) return true;
  return evaluateFilter(workflow.filter, row);
}

/**
 * Incremental watermark comparison: numeric when both values parse to finite
 * numbers, otherwise plain string comparison. Equal values do not pass.
 */
/** String form of a field value; browser extraction yields strings, unit fixtures may not. */
function fieldValueText(value: CollectionRecordValue | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return String(value);
}

function exceedsWatermark(field: string, row: FieldRow, previous: string | undefined): boolean {
  if (previous === undefined) return true;
  const raw = fieldValueText(row[field]);
  const left = Number(raw);
  const right = Number(previous);
  if (
    raw.trim() !== "" &&
    previous.trim() !== "" &&
    Number.isFinite(left) &&
    Number.isFinite(right)
  )
    return left > right;
  return raw > previous;
}

/** Shared admission gate for a candidate record: filter, dedupe, then record/byte budget. */
function admitRecord(
  workflow: CollectionWorkflow,
  row: FieldRow,
  records: FieldRow[],
  seen: Set<string>,
  bytes: number,
  previousWatermark: string | undefined,
): { admitted: boolean; bytes: number; limit: boolean } {
  if (workflow.watermark && !exceedsWatermark(workflow.watermark.field, row, previousWatermark))
    return { admitted: false, bytes, limit: false };
  if (!passesFilter(workflow, row)) return { admitted: false, bytes, limit: false };
  const key = dedupeKey(row, workflow.dedupe);
  if (seen.has(key)) return { admitted: false, bytes, limit: false };
  const size = new TextEncoder().encode(JSON.stringify(row)).byteLength;
  if (records.length >= workflow.maxRecords || bytes + size > 2_000_000)
    return { admitted: false, bytes, limit: true };
  records.push(row);
  seen.add(key);
  return { admitted: true, bytes: bytes + size, limit: false };
}

/** Trusted interpreter for a finite, schema-validated browser collection recipe. */
export async function collectPages(
  ctx: ScriptContext,
  input: ScriptInput,
): Promise<DocumentSnapshot> {
  if (!input.workflow || !ctx.browser.automation) throw new AppError("INVALID_INPUT");
  const workflow = resolveWorkflow(input.workflow, input.parameters);
  const browser = ctx.browser.automation;
  await ctx.step("navigate", () => ctx.browser.navigate(input.url, ctx.signal), input.url);
  const captures: Record<string, string> = {};
  /** Fills `{{response:name}}` placeholders with bodies captured so far. */
  const substituteCaptures = (text: string): string =>
    text.replace(/\{\{response:([a-zA-Z][a-zA-Z0-9_]*)\}\}/gu, (_match, name: string) => {
      if (!Object.hasOwn(captures, name)) throw new AppError("INVALID_INPUT");
      return captures[name] ?? "";
    });
  /** Executes one request spec with bounded retry; returns the response body. */
  const fetchWithRetry = async (spec: HttpRequestSpec): Promise<string> => {
    if (!ctx.http) throw new AppError("INVALID_INPUT");
    const request = {
      method: spec.method,
      url: substituteCaptures(spec.url),
      headers: Object.fromEntries(
        Object.entries(spec.headers).map(([key, value]) => [key, substituteCaptures(value)]),
      ),
      ...(spec.body !== undefined && { body: substituteCaptures(spec.body) }),
      ...(spec.useSession && { useSession: true }),
    };
    // Bounded retry: a failed attempt (network/timeout/status) is replayed until
    // attempts run out; cancellation aborts the loop rather than retrying.
    const attempts = (spec.retries ?? 0) + 1;
    const delayMs = spec.retryDelayMs ?? defaultRetryDelayMs;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await wait(ctx.signal, delayMs);
      try {
        const response = await ctx.http.fetch(
          request,
          spec.timeoutMs,
          spec.capture?.maxLength ?? 4096,
          ctx.signal,
        );
        if (response.status !== spec.expectStatus) throw new AppError("REQUEST_FAILED");
        if (spec.capture) captures[spec.capture.name] = response.body;
        return response.body;
      } catch (error) {
        ctx.signal.throwIfAborted();
        lastError = error;
      }
    }
    throw lastError;
  };
  for (const action of workflow.before) {
    if (action.kind === "request") {
      const spec = action.request;
      const label = `request: ${spec.method} ${spec.url}`;
      const run = async (): Promise<void> => {
        await fetchWithRetry(spec);
      };
      // `when` for a request is validated against the page, mirroring element actions.
      if (action.when && !(await browser.exists(action.when.exists, ctx.signal))) {
        ctx.skip("request", `${label} (missing: ${action.when.exists})`);
        continue;
      }
      if (action.onError === "skip") await ctx.attempt("request", run, label);
      else await ctx.step("request", run, label);
      continue;
    }
    const label = `${action.kind}: ${action.selector}`;
    if (action.when && !(await browser.exists(action.when.exists, ctx.signal))) {
      ctx.skip(action.kind, `${label} (missing: ${action.when.exists})`);
      continue;
    }
    const act = async () => {
      if (action.kind === "fill") {
        action.value = substituteCaptures(action.value);
      }
      await browser.act(action, workflow.waitTimeoutMs, ctx.signal);
    };
    // A best-effort action records its own failure as a skip instead of aborting the page.
    if (action.onError === "skip") await ctx.attempt(action.kind, act, label);
    else await ctx.step(action.kind, act, label);
  }
  const records: FieldRow[] = [];
  const seen = new Set<string>();
  let signature: string | undefined;
  let previousUrl: string | undefined;
  let pages = 0;
  let bytes = 0;
  let detailCapped = false;
  let stopReason: NonNullable<DocumentSnapshot["collection"]>["stopReason"] = "single-page";
  // Incremental watermark: the previous run's value, and the new high-water value of this run.
  const watermarkField = workflow.watermark?.field;
  let previousWatermark: string | undefined;
  if (watermarkField) previousWatermark = input.watermark;
  let watermark: string | undefined;
  // Optional record provenance, applied when a row is admitted on its originating list page.
  const source = workflow.source;
  const trackWatermark = (row: FieldRow): void => {
    if (!watermarkField) return;
    const raw = fieldValueText(row[watermarkField]);
    if (raw === "") return;
    if (
      watermark === undefined ||
      exceedsWatermark(watermarkField, { [watermarkField]: raw }, watermark)
    )
      watermark = raw;
  };
  while (true) {
    ctx.signal.throwIfAborted();
    const rows = await ctx.step(
      "extract",
      async () => {
        const deadline = Date.now() + workflow.waitTimeoutMs;
        while (true) {
          const current = applyExpressions(
            workflow.extract,
            await browser.extract(workflow.extract, ctx.signal),
          );
          const nextSignature = JSON.stringify(current);
          if (current.length && nextSignature !== signature) {
            signature = nextSignature;
            return current;
          }
          if (Date.now() >= deadline) {
            // Let an unchanged response settle before identifying a duplicate page.
            // A click that changes neither the URL nor the data remains a timeout.
            if (current.length && previousUrl !== undefined) {
              const document = await ctx.browser.inspect(ctx.signal);
              if (document.url !== previousUrl) return current;
            }
            throw new AppError("TIMEOUT");
          }
          await pause(ctx.signal);
        }
      },
      workflow.extract.items,
    );
    pages++;
    // Provenance is attached before admission so filters/dedupe can also reference it.
    let pageUrl = input.url;
    if (source?.url)
      pageUrl = (await ctx.step("inspect", () => ctx.browser.inspect(ctx.signal))).url;
    const decoratePage = (list: FieldRow[], origin: "list" | "nested"): FieldRow[] => {
      if (!source) return list;
      return list.map((row) => {
        const next: FieldRow = { ...row };
        if (source.url) next.sourceUrl = pageUrl;
        if (source.page) next.sourcePage = pages;
        if (source.origin) next.sourceOrigin = origin;
        return next;
      });
    };
    const pageRows = decoratePage(rows, "list");
    let added = 0;
    for (const row of pageRows) {
      const result = admitRecord(workflow, row, records, seen, bytes, previousWatermark);
      bytes = result.bytes;
      if (result.limit) {
        stopReason = "record-limit";
        break;
      }
      if (result.admitted) {
        added++;
        trackWatermark(row);
      }
    }
    if (stopReason === "record-limit") break;
    // Detail traversal runs once per list page, before pagination advances.
    const budget: CollectionBudget = {
      seen,
      bytes,
      stopReason: stopReason as CollectionBudget["stopReason"],
    };
    detailCapped =
      (await traverseDetails(
        ctx,
        browser,
        workflow,
        pageRows,
        records,
        budget,
        previousWatermark,
        decoratePage,
      )) || detailCapped;
    bytes = budget.bytes;
    if (budget.stopReason === "record-limit") {
      stopReason = "record-limit";
      break;
    }
    if (added === 0) {
      // With an active watermark an empty page means the previous high-water mark was reached.
      if (previousWatermark !== undefined) stopReason = "watermark-reached";
      else stopReason = "no-new-records";
      break;
    }
    if (!workflow.pagination) break;
    const pageLimitReached = pages >= workflow.pagination.maxPages;
    if ("urlTemplate" in workflow.pagination) {
      if (pageLimitReached) {
        stopReason = "page-limit";
        break;
      }
      previousUrl = (await ctx.browser.inspect(ctx.signal)).url;
      const target = substituteCaptures(
        workflow.pagination.urlTemplate.replace(
          /\{\{page\}\}/gu,
          String(workflow.pagination.startPage + pages),
        ),
      );
      await ctx.step("navigate", () => ctx.browser.navigate(target, ctx.signal), target);
      await pause(ctx.signal);
      continue;
    }
    if ("cursor" in workflow.pagination) {
      if (pageLimitReached) {
        stopReason = "page-limit";
        break;
      }
      const { request, pattern } = workflow.pagination.cursor;
      const label = `request: ${request.method} ${request.url}`;
      const body = await ctx.step("request", () => fetchWithRetry(request), label);
      // The first capture group of the pattern extracts the next page URL from
      // the response body; no match means the cursor is exhausted.
      const match = new RegExp(pattern, "u").exec(body);
      if (!match) {
        stopReason = "cursor-exhausted";
        break;
      }
      const target = match[1] ?? match[0];
      previousUrl = (await ctx.browser.inspect(ctx.signal)).url;
      await ctx.step("navigate", () => ctx.browser.navigate(target, ctx.signal), target);
      await pause(ctx.signal);
      continue;
    }
    const nextSelector = workflow.pagination.next;
    if (!(await browser.exists(nextSelector, ctx.signal))) {
      stopReason = "next-unavailable";
      break;
    }
    if (pageLimitReached) {
      stopReason = "page-limit";
      break;
    }
    previousUrl = (await ctx.browser.inspect(ctx.signal)).url;
    await ctx.step(
      "click",
      () =>
        browser.act({ kind: "click", selector: nextSelector }, workflow.waitTimeoutMs, ctx.signal),
      `click: ${nextSelector}`,
    );
    await pause(ctx.signal);
  }
  const document = await ctx.step("inspect", () => ctx.browser.inspect(ctx.signal));
  // Output mapping applies last, so filter/dedupe/watermark stay expressed in source names.
  const mapping = mappingTarget(workflow);
  let delivered = records;
  if (mapping.size) {
    delivered = records.map((row) => {
      const next: FieldRow = {};
      for (const [key, value] of Object.entries(row)) next[mapping.get(key) ?? key] = value;
      return next;
    });
  }
  return {
    ...document,
    records: delivered,
    collection: {
      pages,
      stopReason,
      truncated: stopReason === "page-limit" || stopReason === "record-limit" || detailCapped,
      ...(watermark !== undefined && { watermark }),
    },
  };
}

/** Shared deduplication and byte budget so nested rows obey the same limits as list rows. */
type CollectionBudget = {
  seen: Set<string>;
  bytes: number;
  stopReason: NonNullable<DocumentSnapshot["collection"]>["stopReason"];
};

/**
 * Opens each list row's detail page in order, merges the extracted fields into the matching
 * record, then returns to the list. Returns true when the configured item limit was reached.
 */
function backStepDetail(back: string | undefined): string {
  // Evidence names the explicit back control when configured, otherwise real history.
  if (back) return `back: ${back}`;
  return "history back";
}

async function traverseDetails(
  ctx: ScriptContext,
  browser: BrowserAutomationPort,
  workflow: CollectionWorkflow,
  rows: FieldRow[],
  records: FieldRow[],
  budget: CollectionBudget,
  previousWatermark: string | undefined,
  /** Attaches provenance to nested rows using the originating list page's URL/number. */
  decoratePage: (rows: FieldRow[], origin: "list" | "nested") => FieldRow[],
): Promise<boolean> {
  const detail = workflow.detail;
  if (!detail) return false;
  const count = await browser.snapshotItems(workflow.extract.items, ctx.signal);
  const limit = Math.min(count, detail.maxItems);
  const keys = rows.map((row) => JSON.stringify(row));
  for (let index = 0; index < limit; index++) {
    ctx.signal.throwIfAborted();
    const key = keys[index];
    const target = records.find((entry) => JSON.stringify(entry) === key);
    await ctx.step(
      "click",
      () =>
        browser.actOnItem(
          index,
          { kind: "click", selector: detail.link },
          workflow.waitTimeoutMs,
          ctx.signal,
        ),
      `detail: ${detail.link}`,
    );
    const extracted = await extractFirst(ctx, browser, detail.extract, workflow.waitTimeoutMs);
    if (target) Object.assign(target, extracted);
    // A nested list on the detail page yields its own rows; each becomes a standalone record.
    const rowsExtraction = detail.rows;
    if (rowsExtraction) {
      const nested = await ctx.step(
        "extract",
        async () => {
          const page = await browser.extract(rowsExtraction, ctx.signal);
          return applyExpressions(rowsExtraction, page);
        },
        rowsExtraction.items,
      );
      const nestedRows = decoratePage(nested, "nested");
      if (nestedRows.length) {
        const child = detail.children;
        if (child) {
          // Nested rows must land in the dataset first so child merges have targets.
          for (const row of nestedRows) {
            const result = admitRecord(
              workflow,
              row,
              records,
              budget.seen,
              budget.bytes,
              previousWatermark,
            );
            budget.bytes = result.bytes;
            if (result.limit) {
              budget.stopReason = "record-limit";
              break;
            }
          }
          if (budget.stopReason !== "record-limit") {
            await traverseDetails(
              ctx,
              browser,
              { ...workflow, extract: rowsExtraction, detail: child },
              nestedRows,
              records,
              budget,
              previousWatermark,
              decoratePage,
            );
          }
        } else {
          for (const row of nestedRows) {
            const result = admitRecord(
              workflow,
              row,
              records,
              budget.seen,
              budget.bytes,
              previousWatermark,
            );
            budget.bytes = result.bytes;
            if (result.limit) {
              budget.stopReason = "record-limit";
              break;
            }
          }
        }
      }
    }
    await ctx.step(
      "navigate",
      async () => {
        const back = ctx.browser.goBack;
        if (!back) {
          // Without history support the workflow must supply an explicit return control.
          if (!detail.back) throw new AppError("INVALID_INPUT");
          await browser.act(
            { kind: "click", selector: detail.back },
            workflow.waitTimeoutMs,
            ctx.signal,
          );
          return;
        }
        try {
          await back.call(ctx.browser, ctx.signal);
        } catch (error) {
          // A profile with no usable history falls back to the configured back control.
          if (!detail.back || !(error instanceof AppError) || error.code !== "INVALID_INPUT")
            throw error;
          await browser.act(
            { kind: "click", selector: detail.back },
            workflow.waitTimeoutMs,
            ctx.signal,
          );
        }
      },
      backStepDetail(detail.back),
    );
    await pause(ctx.signal);
  }
  return count > detail.maxItems;
}

/** Waits until the scoped extraction yields at least one record and returns the first one. */
async function extractFirst(
  ctx: ScriptContext,
  browser: BrowserAutomationPort,
  extraction: Extraction,
  waitTimeoutMs: number,
): Promise<FieldRow> {
  return ctx.step(
    "extract",
    async () => {
      const deadline = Date.now() + waitTimeoutMs;
      while (true) {
        const current = applyExpressions(extraction, await browser.extract(extraction, ctx.signal));
        if (current.length) return current[0] ?? {};
        if (Date.now() >= deadline) throw new AppError("TIMEOUT");
        await pause(ctx.signal);
      }
    },
    extraction.items,
  );
}
