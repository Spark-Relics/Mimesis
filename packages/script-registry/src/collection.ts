import {
  AppError,
  type CollectionWorkflow,
  collectionWorkflowSchema,
  type DetailTraversal,
  type DocumentSnapshot,
  type Extraction,
  type WorkflowPlan,
  workflowParametersSchema,
  workflowPlanSchema,
} from "@clawler/contracts";
import type { BrowserAutomationPort, ScriptContext, ScriptInput } from "@clawler/script-sdk";
import { evaluateExpression } from "./expression.js";
import { parameterNames, validateForPublish } from "./versions.js";

/** Computes expression-backed fields in place after selector extraction. */
function applyExpressions(
  extraction: Extraction,
  rows: Array<Record<string, string>>,
): Array<Record<string, string>> {
  for (const field of extraction.fields) {
    if (!field.expression) continue;
    for (const row of rows) row[field.name] = evaluateExpression(field.expression, row);
  }
  return rows;
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
  for (const action of workflow.before) {
    if (action.kind === "fill") action.value = substitute(action.value);
    if (action.kind === "request") {
      action.request = {
        ...action.request,
        url: substitute(action.request.url),
        headers: Object.fromEntries(
          Object.entries(action.request.headers).map(([key, value]) => [key, substitute(value)]),
        ),
        ...(action.request.body !== undefined && { body: substitute(action.request.body) }),
      };
    }
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

function fieldNames(extract: Extraction): string[] {
  return extract.fields.map((field) => field.name);
}

function traversalNames(node: DetailTraversal): string[] {
  let nested: string[] = [];
  if (node.children) nested = traversalNames(node.children);
  let rows: string[] = [];
  if (node.rows) rows = fieldNames(node.rows);
  return [...fieldNames(node.extract), ...rows, ...nested];
}

/** Fixed input/output contract derived from the immutable workflow content. */
export function planWorkflow(input: CollectionWorkflow): WorkflowPlan {
  const workflow = validateForPublish(input);
  let detailFields: string[] = [];
  if (workflow.detail) detailFields = traversalNames(workflow.detail);
  const output = [...fieldNames(workflow.extract), ...detailFields];
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

async function pause(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 150);
    signal.addEventListener("abort", abort, { once: true });
  });
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
  for (const action of workflow.before) {
    if (action.kind === "request") {
      const spec = action.request;
      const label = `request: ${spec.method} ${spec.url}`;
      const run = async (): Promise<void> => {
        if (!ctx.http) throw new AppError("INVALID_INPUT");
        const response = await ctx.http.fetch(
          {
            method: spec.method,
            url: substituteCaptures(spec.url),
            headers: Object.fromEntries(
              Object.entries(spec.headers).map(([key, value]) => [key, substituteCaptures(value)]),
            ),
            ...(spec.body !== undefined && { body: substituteCaptures(spec.body) }),
          },
          spec.timeoutMs,
          spec.capture?.maxLength ?? 4096,
          ctx.signal,
        );
        if (response.status !== spec.expectStatus) throw new AppError("REQUEST_FAILED");
        if (spec.capture) captures[spec.capture.name] = response.body;
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
  const records: Array<Record<string, string>> = [];
  const seen = new Set<string>();
  let signature: string | undefined;
  let previousUrl: string | undefined;
  let pages = 0;
  let bytes = 0;
  let detailCapped = false;
  let stopReason: NonNullable<DocumentSnapshot["collection"]>["stopReason"] = "single-page";
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
    let added = 0;
    for (const row of rows) {
      const key = JSON.stringify(row);
      if (seen.has(key)) continue;
      const size = new TextEncoder().encode(key).byteLength;
      if (records.length >= workflow.maxRecords || bytes + size > 2_000_000) {
        stopReason = "record-limit";
        break;
      }
      records.push(row);
      seen.add(key);
      bytes += size;
      added++;
    }
    if (stopReason === "record-limit") break;
    // Detail traversal runs once per list page, before pagination advances.
    const budget: CollectionBudget = {
      seen,
      bytes,
      stopReason: stopReason as CollectionBudget["stopReason"],
    };
    detailCapped =
      (await traverseDetails(ctx, browser, workflow, rows, records, budget)) || detailCapped;
    bytes = budget.bytes;
    if (budget.stopReason === "record-limit") {
      stopReason = "record-limit";
      break;
    }
    if (added === 0) {
      stopReason = "no-new-records";
      break;
    }
    if (!workflow.pagination) break;
    if (!(await browser.exists(workflow.pagination.next, ctx.signal))) {
      stopReason = "next-unavailable";
      break;
    }
    if (pages >= workflow.pagination.maxPages) {
      stopReason = "page-limit";
      break;
    }
    previousUrl = (await ctx.browser.inspect(ctx.signal)).url;
    await ctx.step(
      "click",
      () =>
        browser.act(
          { kind: "click", selector: workflow.pagination?.next ?? "" },
          workflow.waitTimeoutMs,
          ctx.signal,
        ),
      `click: ${workflow.pagination?.next ?? ""}`,
    );
    await pause(ctx.signal);
  }
  const document = await ctx.step("inspect", () => ctx.browser.inspect(ctx.signal));
  return {
    ...document,
    records,
    collection: {
      pages,
      stopReason,
      truncated: stopReason === "page-limit" || stopReason === "record-limit" || detailCapped,
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
  rows: Array<Record<string, string>>,
  records: Array<Record<string, string>>,
  budget: CollectionBudget,
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
      if (nested.length) {
        const child = detail.children;
        if (child) {
          // Nested rows must land in the dataset first so child merges have targets.
          for (const row of nested) {
            const rowKey = JSON.stringify(row);
            if (budget.seen.has(rowKey)) continue;
            const size = new TextEncoder().encode(rowKey).byteLength;
            if (records.length >= workflow.maxRecords || budget.bytes + size > 2_000_000) {
              budget.stopReason = "record-limit";
              break;
            }
            records.push(row);
            budget.seen.add(rowKey);
            budget.bytes += size;
          }
          if (budget.stopReason !== "record-limit") {
            await traverseDetails(
              ctx,
              browser,
              { ...workflow, extract: rowsExtraction, detail: child },
              nested,
              records,
              budget,
            );
          }
        } else {
          for (const row of nested) {
            const rowKey = JSON.stringify(row);
            const size = new TextEncoder().encode(rowKey).byteLength;
            if (records.length >= workflow.maxRecords || budget.bytes + size > 2_000_000) {
              budget.stopReason = "record-limit";
              break;
            }
            if (budget.seen.has(rowKey)) continue;
            records.push(row);
            budget.seen.add(rowKey);
            budget.bytes += size;
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
): Promise<Record<string, string>> {
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
