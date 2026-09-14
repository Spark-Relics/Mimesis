import {
  AppError,
  type CollectionWorkflow,
  collectionWorkflowSchema,
  type DocumentSnapshot,
  workflowParametersSchema,
} from "@clawler/contracts";
import type { BrowserAutomationPort, ScriptContext, ScriptInput } from "@clawler/script-sdk";

export function resolveWorkflow(
  input: CollectionWorkflow,
  parameters: Record<string, string> = {},
): CollectionWorkflow {
  const workflow = collectionWorkflowSchema.parse(input);
  const values = workflowParametersSchema.parse(parameters);
  for (const action of workflow.before) {
    if (action.kind !== "fill") continue;
    action.value = action.value.replace(
      /\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/gu,
      (_match, name: string) => {
        if (!Object.hasOwn(values, name)) throw new AppError("INVALID_INPUT");
        return values[name] ?? "";
      },
    );
  }
  return collectionWorkflowSchema.parse(workflow);
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
  for (const action of workflow.before) {
    const label = `${action.kind}: ${action.selector}`;
    if (action.when && !(await browser.exists(action.when.exists, ctx.signal))) {
      ctx.skip(action.kind, `${label} (missing: ${action.when.exists})`);
      continue;
    }
    const act = () => browser.act(action, workflow.waitTimeoutMs, ctx.signal);
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
          const current = await browser.extract(workflow.extract, ctx.signal);
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
    detailCapped = (await traverseDetails(ctx, browser, workflow, rows, records)) || detailCapped;
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
    const extracted = await ctx.step(
      "extract",
      async () => {
        const deadline = Date.now() + workflow.waitTimeoutMs;
        while (true) {
          const current = await browser.extract(detail.extract, ctx.signal);
          if (current.length) return current[0] ?? {};
          if (Date.now() >= deadline) throw new AppError("TIMEOUT");
          await pause(ctx.signal);
        }
      },
      detail.extract.items,
    );
    if (target) Object.assign(target, extracted);
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
