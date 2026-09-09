import {
  AppError,
  type CollectionWorkflow,
  collectionWorkflowSchema,
  type DocumentSnapshot,
  workflowParametersSchema,
} from "@clawler/contracts";
import type { ScriptContext, ScriptInput } from "@clawler/script-sdk";

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
  await ctx.step("navigate", () => ctx.browser.navigate(input.url, ctx.signal));
  for (const action of workflow.before)
    await ctx.step(action.kind, () => browser.act(action, workflow.waitTimeoutMs, ctx.signal));
  const records: Array<Record<string, string>> = [];
  const seen = new Set<string>();
  let signature: string | undefined;
  let previousUrl: string | undefined;
  let pages = 0;
  let bytes = 0;
  let stopReason: NonNullable<DocumentSnapshot["collection"]>["stopReason"] = "single-page";
  while (true) {
    ctx.signal.throwIfAborted();
    const rows = await ctx.step("extract", async () => {
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
    });
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
    if (added === 0) {
      stopReason = "no-new-records";
      break;
    }
    if (!workflow.pagination) break;
    if (!(await browser.hasNext(workflow.pagination.next, ctx.signal))) {
      stopReason = "next-unavailable";
      break;
    }
    if (pages >= workflow.pagination.maxPages) {
      stopReason = "page-limit";
      break;
    }
    previousUrl = (await ctx.browser.inspect(ctx.signal)).url;
    await ctx.step("click", () =>
      browser.act(
        { kind: "click", selector: workflow.pagination?.next ?? "" },
        workflow.waitTimeoutMs,
        ctx.signal,
      ),
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
      truncated: stopReason === "page-limit" || stopReason === "record-limit",
    },
  };
}
