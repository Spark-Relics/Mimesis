import {
  AppError,
  type CollectionWorkflow,
  type DetailTraversal,
  type StepKind,
  type WorkflowAction,
} from "@clawler/contracts";
import type { HttpPort, ScriptContext } from "@clawler/script-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectPages, dryRunWorkflow, planWorkflow, resolveWorkflow } from "./collection";
import { dedupeKey } from "./fields";
import { parameterNames, validateForPublish, workflowDigest } from "./versions";

/** Request actions carry a URL instead of a selector; both matter in `act` evidence. */
function actionTarget(action: WorkflowAction): string {
  if (action.kind === "request") return action.request.url;
  return action.selector;
}

const recipe: CollectionWorkflow = {
  version: 1,
  before: [
    { kind: "fill", selector: "#search", value: "{{query}}" },
    { kind: "click", selector: "#submit" },
  ],
  extract: {
    items: ".item",
    fields: [{ name: "name", selector: ".name", attribute: "text", required: true }],
  },
  pagination: { next: ".next", maxPages: 3 },
  waitTimeoutMs: 300,
  maxRecords: 10,
  dedupe: [],
};

function fixture(
  pages: Array<Array<Record<string, string>>>,
  sameUrl = false,
  present?: readonly string[],
  failOn?: string,
) {
  let index = 0;
  const controller = new AbortController();
  const steps: Array<{ kind: StepKind; detail: string | undefined; skipped: boolean }> = [];
  const automation = {
    act: vi.fn(async (action: WorkflowAction) => {
      if (failOn && "selector" in action && action.selector === failOn)
        throw new AppError("TIMEOUT");
      if ("selector" in action && action.selector === ".next") index++;
    }),
    extract: vi.fn(async () => pages[index] ?? []),
    snapshotItems: vi.fn(async () => 0),
    actOnItem: vi.fn(async (_index: number) => undefined),
    exists: vi.fn(async (selector: string) => {
      if (present) return present.includes(selector);
      return index < pages.length - 1;
    }),
  };
  const http: HttpPort = { fetch: vi.fn(async () => ({ status: 200, body: "" })) };
  const ctx: ScriptContext = {
    signal: controller.signal,
    http,
    browser: {
      automation,
      navigate: vi.fn(async () => undefined),
      goBack: vi.fn(async () => undefined),
      inspect: vi.fn(async () => {
        let url = `https://example.com/${index}`;
        if (sameUrl) url = "https://example.com/";
        return { url, title: "Test", headings: [], links: [] };
      }),
    },
    async step(kind, action, detail) {
      steps.push({ kind, detail, skipped: false });
      return action();
    },
    async attempt(kind, action, detail) {
      try {
        return await action();
      } catch (error) {
        if (controller.signal.aborted) throw error;
        steps.push({ kind, detail, skipped: true });
        return undefined;
      }
    },
    skip(kind, detail) {
      steps.push({ kind, detail, skipped: true });
    },
  };
  return { ctx, automation, controller, steps, http };
}

afterEach(() => vi.useRealTimers());

describe("reusable collection interpreter", () => {
  it("derives a fixed input/output schema from the workflow", () => {
    const traversal: DetailTraversal = {
      link: ".link",
      extract: {
        items: ".detail",
        fields: [{ name: "body", selector: ".body", attribute: "text", required: true }],
      },
      maxItems: 5,
      rows: {
        items: ".rows",
        fields: [{ name: "rowName", selector: ".row-name", attribute: "text", required: true }],
      },
    };
    const plan = planWorkflow({
      ...recipe,
      detail: traversal,
    });
    expect(plan).toEqual({
      input: ["query"],
      output: ["name", "body", "rowName"],
      maxPages: 3,
      maxRecords: 10,
      maxItemsPerPage: 5,
    });
  });

  it("rejects a plan with duplicate output field names across extractions", () => {
    expect(() =>
      planWorkflow({
        ...recipe,
        detail: {
          link: ".link",
          extract: {
            items: ".detail",
            fields: [{ name: "name", selector: ".body", attribute: "text", required: true }],
          },
          maxItems: 5,
        },
      }),
    ).toThrow("INVALID_INPUT");
  });

  it("bounds a dry run to a single page with capped budgets", () => {
    const dry = dryRunWorkflow(recipe);
    expect(dry.pagination).toBeNull();
    expect(dry.maxRecords).toBe(10);
    const withDetail = dryRunWorkflow({
      ...recipe,
      maxRecords: 2000,
      detail: {
        link: ".link",
        extract: {
          items: ".detail",
          fields: [{ name: "body", selector: ".body", attribute: "text", required: true }],
        },
        maxItems: 500,
      },
    });
    expect(withDetail.maxRecords).toBe(20);
    expect(withDetail.detail?.maxItems).toBe(3);
    // The source recipe stays untouched.
    expect(recipe.pagination).toEqual({ next: ".next", maxPages: 3 });
  });

  it("substitutes only fill parameters once without changing the saved recipe", () => {
    const resolved = resolveWorkflow(recipe, { query: "literal {{other}} $&" });
    expect(resolved.before[0]).toEqual({
      kind: "fill",
      selector: "#search",
      value: "literal {{other}} $&",
    });
    expect(recipe.before[0]).toHaveProperty("value", "{{query}}");
    expect(() => resolveWorkflow(recipe)).toThrow("INVALID_INPUT");
  });

  it("performs HTTP requests, captures bodies, and feeds them into later fill actions", async () => {
    const { ctx, steps, http, automation } = fixture([[{ name: "A" }]]);
    const seen: Array<{ method: string; url: string; body?: string }> = [];
    http.fetch = vi.fn(async (request) => {
      seen.push({ ...request });
      return { status: 200, body: `token-for-${request.url.split("q=")[1] ?? ""}` };
    });
    const workflow: CollectionWorkflow = {
      ...recipe,
      before: [
        {
          kind: "request",
          request: {
            method: "GET",
            url: "https://api.example.com/search?q={{query}}",
            headers: {},
            timeoutMs: 5000,
            expectStatus: 200,
            capture: { name: "token", maxLength: 64000 },
          },
        },
        { kind: "fill", selector: "#search", value: "{{response:token}}" },
      ],
      pagination: null,
    };
    const result = await collectPages(ctx, {
      url: "https://example.com",
      workflow,
      parameters: { query: "hello" },
    });
    expect(seen).toEqual([
      { method: "GET", url: "https://api.example.com/search?q=hello", headers: {} },
    ]);
    expect(result.records).toEqual([{ name: "A" }]);
    expect(steps.map((entry) => entry.kind)).toContain("request");
    // The captured body reached the fill value after parameters resolved.
    const fillCall = automation.act.mock.calls.find(([action]) => action.kind === "fill");
    expect(fillCall?.[0]).toMatchObject({ kind: "fill", value: "token-for-hello" });
  });

  it("fails the run when an HTTP response does not match expectStatus", async () => {
    const { ctx, steps, http } = fixture([[{ name: "A" }]]);
    http.fetch = vi.fn(async () => ({ status: 503, body: "unavailable" }));
    const workflow: CollectionWorkflow = {
      ...recipe,
      before: [
        {
          kind: "request",
          request: {
            method: "GET",
            url: "https://api.example.com/search",
            headers: {},
            timeoutMs: 5000,
            expectStatus: 200,
          },
        },
      ],
      pagination: null,
    };
    const rejection = collectPages(ctx, {
      url: "https://example.com",
      workflow,
      parameters: {},
    });
    await expect(rejection).rejects.toThrow("REQUEST_FAILED");
    expect(steps.at(-1)?.skipped).toBe(false);
  });

  it("rejects response references that no preceding request captures", () => {
    const workflow: CollectionWorkflow = {
      ...recipe,
      before: [{ kind: "fill", selector: "#search", value: "{{response:missing}}" }],
      pagination: null,
    };
    expect(() => resolveWorkflow(workflow)).not.toThrow();
    expect(() => parameterNames(workflow)).toThrow("INVALID_INPUT");
  });

  it("runs setup once, paginates, deduplicates overlap, and reports an absent next button", async () => {
    vi.useFakeTimers();
    const { ctx, automation, steps } = fixture([[{ name: "A" }], [{ name: "A" }, { name: "B" }]]);
    const resultPromise = collectPages(ctx, {
      url: "https://example.com",
      workflow: recipe,
      parameters: { query: "hello" },
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result.records).toEqual([{ name: "A" }, { name: "B" }]);
    expect(result.collection).toEqual({
      pages: 2,
      stopReason: "next-unavailable",
      truncated: false,
    });
    expect(automation.act.mock.calls.map(([action]) => actionTarget(action))).toEqual([
      "#search",
      "#submit",
      ".next",
    ]);
    expect(steps.map((entry) => entry.kind)).toEqual([
      "navigate",
      "fill",
      "click",
      "extract",
      "click",
      "extract",
      "inspect",
    ]);
    // Evidence names the URL, selectors and item selector each step acted on.
    expect(steps.map((entry) => entry.detail)).toEqual([
      "https://example.com",
      "fill: #search",
      "click: #submit",
      ".item",
      "click: .next",
      ".item",
      undefined,
    ]);
  });

  it("deduplicates by configured field names across pages", async () => {
    vi.useFakeTimers();
    // Same name on both pages; the second copy with a different extra field is dropped.
    const pages = [
      [{ name: "A", note: "first" }],
      [
        { name: "A", note: "second" },
        { name: "B", note: "x" },
      ],
    ];
    const { ctx } = fixture(pages);
    const workflow: CollectionWorkflow = {
      ...recipe,
      dedupe: ["name"],
      extract: {
        items: ".item",
        fields: [
          { name: "name", selector: ".name", attribute: "text", required: true },
          { name: "note", selector: ".note", attribute: "text", required: false },
        ],
      },
    };
    const resultPromise = collectPages(ctx, {
      url: "https://example.com",
      workflow,
      parameters: { query: "hello" },
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result.records).toEqual([
      { name: "A", note: "first" },
      { name: "B", note: "x" },
    ]);
  });

  it("falls back to the whole-record key when a record carries no dedupe field", () => {
    expect(dedupeKey({ a: "1", b: "2" }, ["missing"])).toBe(JSON.stringify({ a: "1", b: "2" }));
    expect(dedupeKey({ a: "1", b: "2" }, ["a"])).toBe(JSON.stringify([["a", "1"]]));
    expect(dedupeKey({ a: "1" }, [])).toBe(JSON.stringify({ a: "1" }));
  });

  it("accepts the per-extraction missing policy without changing old content digests", () => {
    const rowPolicy = validateForPublish({
      ...recipe,
      extract: { ...recipe.extract, missing: "row" },
    });
    expect(rowPolicy.extract.missing).toBe("row");
    expect(() =>
      validateForPublish({
        ...recipe,
        extract: { ...recipe.extract, missing: "pageX" as unknown as "row" },
      }),
    ).toThrow();
    // Old published content never carries the key; absent must stay identity-neutral.
    expect(workflowDigest("https://example.com", recipe)).toBe(
      workflowDigest("https://example.com", { ...recipe, extract: { ...recipe.extract } }),
    );
  });

  it("accepts dedupe fields that exist in the plan output and rejects unknown or duplicate names", () => {
    expect(() => validateForPublish({ ...recipe, dedupe: ["name"] })).not.toThrow();
    expect(() => validateForPublish({ ...recipe, dedupe: ["ghost"] })).toThrow("INVALID_INPUT");
    expect(() => validateForPublish({ ...recipe, dedupe: ["name", "name"] })).toThrow(
      "INVALID_INPUT",
    );
  });

  it("drops records whose filter expression evaluates falsy", async () => {
    vi.useFakeTimers();
    const pages: Array<Array<Record<string, string>>> = [
      [{ name: "keep" }, { name: "" }, { name: "other" }],
    ];
    const { ctx } = fixture(pages);
    const workflow: CollectionWorkflow = { ...recipe, filter: '{name} != ""' };
    const resultPromise = collectPages(ctx, {
      url: "https://example.com",
      workflow,
      parameters: { query: "hello" },
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result.records).toEqual([{ name: "keep" }, { name: "other" }]);
  });

  it("rejects filters referencing unknown fields at publish validation", () => {
    expect(() => validateForPublish({ ...recipe, filter: '{name} != ""' })).not.toThrow();
    expect(() => validateForPublish({ ...recipe, filter: '{ghost} != ""' })).toThrow(
      "INVALID_INPUT",
    );
    expect(() => validateForPublish({ ...recipe, filter: "{name" })).toThrow("INVALID_INPUT");
  });

  it("runs only the conditional actions whose element is present and records the rest as skipped", async () => {
    const { ctx, automation, steps } = fixture([[{ name: "A" }]], false, ["#search"]);
    const workflow: CollectionWorkflow = {
      ...recipe,
      before: [
        { kind: "click", selector: "#cookie", when: { exists: "#cookie-banner" } },
        { kind: "fill", selector: "#search", value: "{{query}}", when: { exists: "#search" } },
        { kind: "click", selector: "#submit" },
      ],
      pagination: null,
    };
    const result = await collectPages(ctx, {
      url: "https://example.com",
      workflow,
      parameters: { query: "hello" },
    });
    expect(result.records).toEqual([{ name: "A" }]);
    expect(automation.act.mock.calls.map(([action]) => actionTarget(action))).toEqual([
      "#search",
      "#submit",
    ]);
    expect(steps.map(({ kind, skipped }) => ({ kind, skipped }))).toEqual([
      { kind: "navigate", skipped: false },
      { kind: "click", skipped: true },
      { kind: "fill", skipped: false },
      { kind: "click", skipped: false },
      { kind: "extract", skipped: false },
      { kind: "inspect", skipped: false },
    ]);
    // The skipped step names the unmet condition instead of claiming success.
    expect(steps[1]?.detail).toBe("click: #cookie (missing: #cookie-banner)");
  });

  it("downgrades a failing best-effort action to a skip and still finishes the page", async () => {
    const { ctx, steps } = fixture([[{ name: "A" }]], false, undefined, "#cookie");
    const workflow: CollectionWorkflow = {
      ...recipe,
      before: [
        { kind: "click", selector: "#cookie", onError: "skip" },
        { kind: "fill", selector: "#search", value: "{{query}}" },
      ],
      pagination: null,
    };
    const result = await collectPages(ctx, {
      url: "https://example.com",
      workflow,
      parameters: { query: "hello" },
    });
    // The failing optional action is recorded as skipped, and the page is still collected.
    expect(result.records).toEqual([{ name: "A" }]);
    expect(steps.map(({ kind, skipped }) => ({ kind, skipped }))).toEqual([
      { kind: "navigate", skipped: false },
      { kind: "click", skipped: true },
      { kind: "fill", skipped: false },
      { kind: "extract", skipped: false },
      { kind: "inspect", skipped: false },
    ]);
  });
  it("waits for asynchronously replaced rows instead of collecting stale content twice", async () => {
    vi.useFakeTimers();
    const { ctx, automation } = fixture([[{ name: "A" }], [{ name: "B" }]], true);
    automation.extract
      .mockResolvedValueOnce([{ name: "A" }])
      .mockResolvedValueOnce([{ name: "A" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ name: "B" }]);
    const pending = collectPages(ctx, {
      url: "https://example.com",
      workflow: recipe,
      parameters: { query: "x" },
    });
    await vi.runAllTimersAsync();
    expect((await pending).records).toEqual([{ name: "A" }, { name: "B" }]);
    expect(automation.extract).toHaveBeenCalledTimes(4);
  });

  it("stops a settled duplicate page with a changed URL", async () => {
    vi.useFakeTimers();
    const { ctx } = fixture([[{ name: "A" }], [{ name: "A" }]]);
    const pending = collectPages(ctx, {
      url: "https://example.com",
      workflow: recipe,
      parameters: { query: "x" },
    });
    await vi.runAllTimersAsync();
    expect((await pending).collection).toEqual({
      pages: 2,
      stopReason: "no-new-records",
      truncated: false,
    });
  });

  it("fails a next action that produces no observable change", async () => {
    vi.useFakeTimers();
    const { ctx } = fixture([[{ name: "A" }], [{ name: "A" }]], true);
    const pending = collectPages(ctx, {
      url: "https://example.com",
      workflow: recipe,
      parameters: { query: "x" },
    });
    const assertion = expect(pending).rejects.toThrow("TIMEOUT");
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("reports explicit page and record limits", async () => {
    const first = fixture([[{ name: "A" }], [{ name: "B" }]]);
    const pageLimited = await collectPages(first.ctx, {
      url: "https://example.com",
      workflow: { ...recipe, before: [], pagination: { next: ".next", maxPages: 1 } },
    });
    expect(pageLimited.collection).toEqual({ pages: 1, stopReason: "page-limit", truncated: true });
    expect(first.automation.act).not.toHaveBeenCalled();
    const second = fixture([[{ name: "A" }, { name: "B" }]]);
    const recordLimited = await collectPages(second.ctx, {
      url: "https://example.com",
      workflow: { ...recipe, before: [], maxRecords: 1 },
    });
    expect(recordLimited.records).toEqual([{ name: "A" }]);
    expect(recordLimited.collection?.stopReason).toBe("record-limit");
  });

  it("aborts a page wait without subsequent actions or inspection", async () => {
    vi.useFakeTimers();
    const { ctx, controller, automation } = fixture([[]]);
    const pending = collectPages(ctx, {
      url: "https://example.com",
      workflow: { ...recipe, before: [] },
    });
    const assertion = expect(pending).rejects.toThrow("CANCELLED");
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(new AppError("CANCELLED"));
    await vi.runAllTimersAsync();
    await assertion;
    expect(automation.act).not.toHaveBeenCalled();
  });

  it("opens each list row's detail page, merges its fields and returns to the list", async () => {
    vi.useFakeTimers();
    const { ctx, automation } = fixture([
      [{ name: "Cedar" }, { name: "Birch" }, { name: "Alder" }],
    ]);
    automation.snapshotItems.mockResolvedValue(3);
    automation.extract
      .mockResolvedValueOnce([{ name: "Cedar" }, { name: "Birch" }, { name: "Alder" }])
      // Detail pages contribute one record each: price + summary for the opened page.
      .mockResolvedValueOnce([{ price: "18.00", summary: "evergreen" }])
      .mockResolvedValueOnce([{ price: "12.50", summary: "pioneer" }])
      .mockResolvedValueOnce([{ price: "9.75", summary: "riparian" }])
      // Back on the list page the row signature matches, so the duplicate wait resolves.
      .mockResolvedValue([{ name: "Cedar" }, { name: "Birch" }, { name: "Alder" }]);
    const workflow: CollectionWorkflow = {
      ...recipe,
      before: [],
      pagination: null,
      detail: {
        link: ".detail-link",
        extract: {
          items: "main",
          fields: [
            { name: "price", selector: ".price", attribute: "text", required: true },
            { name: "summary", selector: ".summary", attribute: "text", required: false },
          ],
        },
        maxItems: 10,
      },
    };
    const pending = collectPages(ctx, { url: "https://example.com", workflow });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.records).toEqual([
      { name: "Cedar", price: "18.00", summary: "evergreen" },
      { name: "Birch", price: "12.50", summary: "pioneer" },
      { name: "Alder", price: "9.75", summary: "riparian" },
    ]);
    expect(result.collection).toEqual({
      pages: 1,
      stopReason: "single-page",
      truncated: false,
    });
    expect(automation.actOnItem).toHaveBeenCalledTimes(3);
    expect(automation.actOnItem.mock.calls.map((call) => call[0])).toEqual([0, 1, 2]);
    expect(ctx.browser.goBack).toHaveBeenCalledTimes(3);
    expect(automation.act).not.toHaveBeenCalledWith(
      expect.objectContaining({ selector: ".back" }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("caps detail traversal at maxItems and marks the collection as truncated", async () => {
    vi.useFakeTimers();
    const { ctx, automation } = fixture([[{ name: "Cedar" }, { name: "Birch" }]]);
    automation.snapshotItems.mockResolvedValue(5);
    automation.extract
      .mockResolvedValueOnce([{ name: "Cedar" }, { name: "Birch" }])
      .mockResolvedValueOnce([{ price: "18.00" }])
      .mockResolvedValueOnce([{ price: "12.50" }])
      .mockResolvedValue([{ name: "Cedar" }, { name: "Birch" }]);
    const workflow: CollectionWorkflow = {
      ...recipe,
      before: [],
      pagination: null,
      detail: {
        link: ".detail-link",
        extract: {
          items: "main",
          fields: [{ name: "price", selector: ".price", attribute: "text", required: true }],
        },
        maxItems: 2,
      },
    };
    const pending = collectPages(ctx, { url: "https://example.com", workflow });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.records).toEqual([
      { name: "Cedar", price: "18.00" },
      { name: "Birch", price: "12.50" },
    ]);
    expect(result.collection?.truncated).toBe(true);
    expect(automation.actOnItem).toHaveBeenCalledTimes(2);
  });

  it("collects a nested list on the detail page as standalone records under the shared budget", async () => {
    vi.useFakeTimers();
    const { ctx, automation } = fixture([[{ name: "Cedar" }]]);
    automation.snapshotItems.mockResolvedValue(1);
    automation.extract
      // List page rows, then the detail page merge, then the nested list on the detail page.
      .mockResolvedValueOnce([{ name: "Cedar" }])
      .mockResolvedValueOnce([{ price: "18.00" }])
      .mockResolvedValue([{ sku: "A1" }, { sku: "A2" }, { sku: "A1" }]);
    const workflow: CollectionWorkflow = {
      ...recipe,
      before: [],
      pagination: null,
      maxRecords: 3,
      detail: {
        link: ".detail-link",
        extract: {
          items: "main",
          fields: [{ name: "price", selector: ".price", attribute: "text", required: true }],
        },
        rows: {
          items: ".variants",
          fields: [{ name: "sku", selector: ".sku", attribute: "text", required: true }],
        },
        maxItems: 1,
      },
    };
    const pending = collectPages(ctx, { url: "https://example.com", workflow });
    await vi.runAllTimersAsync();
    const result = await pending;
    // The list row keeps its merged detail fields; nested rows become their own deduplicated records.
    expect(result.records).toEqual([
      { name: "Cedar", price: "18.00" },
      { sku: "A1" },
      { sku: "A2" },
    ]);
  });

  it("opens child detail pages for nested rows and merges their fields", async () => {
    vi.useFakeTimers();
    const { ctx, automation } = fixture([[{ name: "Cedar" }]]);
    automation.snapshotItems
      .mockResolvedValueOnce(1) // Top-level list rows.
      .mockResolvedValueOnce(2); // Nested rows on the detail page.
    automation.extract
      .mockResolvedValueOnce([{ name: "Cedar" }]) // List page.
      .mockResolvedValueOnce([{ price: "18.00" }]) // Detail page merge.
      .mockResolvedValueOnce([{ sku: "A1" }, { sku: "A2" }]) // Nested list.
      .mockResolvedValueOnce([{ stock: "7" }]) // Child detail for row 0.
      .mockResolvedValueOnce([{ stock: "3" }]) // Child detail for row 1.
      .mockResolvedValue([{ sku: "A1" }, { sku: "A2" }]);
    const childTraversal: DetailTraversal = {
      link: ".child-link",
      extract: {
        items: ".stock",
        fields: [{ name: "stock", selector: ".value", attribute: "text", required: true }],
      },
      maxItems: 5,
    };
    const workflow: CollectionWorkflow = {
      ...recipe,
      before: [],
      pagination: null,
      detail: {
        link: ".detail-link",
        extract: {
          items: "main",
          fields: [{ name: "price", selector: ".price", attribute: "text", required: true }],
        },
        rows: {
          items: ".variants",
          fields: [{ name: "sku", selector: ".sku", attribute: "text", required: true }],
        },
        children: childTraversal,
        maxItems: 1,
      },
    };
    const pending = collectPages(ctx, { url: "https://example.com", workflow });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.records).toEqual([
      { name: "Cedar", price: "18.00" },
      { sku: "A1", stock: "7" },
      { sku: "A2", stock: "3" },
    ]);
    // Row 0 opens via the top-level snapshot index, nested rows via their own snapshot scope.
    expect(automation.actOnItem).toHaveBeenCalledWith(
      0,
      { kind: "click", selector: ".detail-link" },
      workflow.waitTimeoutMs,
      ctx.signal,
    );
  });

  it("rejects traversal nesting deeper than three levels at validation time", () => {
    const deep = {
      link: ".a",
      extract: {
        items: "main",
        fields: [{ name: "x", selector: ".x", attribute: "text" as const, required: true }],
      },
      maxItems: 1,
      rows: {
        items: ".r",
        fields: [{ name: "y", selector: ".y", attribute: "text" as const, required: true }],
      },
      children: {
        link: ".b",
        extract: {
          items: "main",
          fields: [{ name: "z", selector: ".z", attribute: "text" as const, required: true }],
        },
        maxItems: 1,
        rows: {
          items: ".r2",
          fields: [{ name: "w", selector: ".w", attribute: "text" as const, required: true }],
        },
        children: {
          link: ".c",
          extract: {
            items: "main",
            fields: [{ name: "v", selector: ".v", attribute: "text" as const, required: true }],
          },
          maxItems: 1,
          rows: {
            items: ".r3",
            fields: [{ name: "u", selector: ".u", attribute: "text" as const, required: true }],
          },
          children: {
            link: ".d",
            extract: {
              items: "main",
              fields: [{ name: "t", selector: ".t", attribute: "text" as const, required: true }],
            },
            maxItems: 1,
          },
        },
      },
    };
    expect(() => resolveWorkflow({ ...recipe, before: [], detail: deep }, {})).toThrow();
  });

  it("computes expression fields after extraction and fails the step on bad expressions", async () => {
    vi.useFakeTimers();
    const { ctx } = fixture([[{ name: "cedar", price: "18.00" }]]);
    const workflow: CollectionWorkflow = {
      ...recipe,
      before: [],
      pagination: null,
      extract: {
        items: ".item",
        fields: [
          { name: "name", selector: ".name", attribute: "text", required: true },
          { name: "price", selector: ".price", attribute: "text", required: true },
          {
            name: "label",
            selector: ".name",
            attribute: "text",
            required: false,
            expression: "upper({name})",
          },
          {
            name: "total",
            selector: ".price",
            attribute: "text",
            required: false,
            expression: "round(number({price}) * 1.1, 2)",
          },
        ],
      },
    };
    const pending = collectPages(ctx, { url: "https://example.com", workflow });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.records).toEqual([
      { name: "cedar", price: "18.00", label: "CEDAR", total: "19.8" },
    ]);

    const failing: CollectionWorkflow = {
      ...recipe,
      before: [],
      pagination: null,
      extract: {
        items: ".item",
        fields: [
          { name: "name", selector: ".name", attribute: "text", required: true },
          {
            name: "bad",
            selector: ".name",
            attribute: "text",
            required: false,
            expression: "eval({name})",
          },
        ],
      },
    };
    const { ctx: badCtx } = fixture([[{ name: "x" }]]);
    const rejection = collectPages(badCtx, { url: "https://example.com", workflow: failing }).catch(
      (error: unknown) => error,
    );
    await vi.runAllTimersAsync();
    await expect(rejection).resolves.toBeInstanceOf(AppError);
  });

  it("normalizes field values before expressions and stays absent-friendly for old content", async () => {
    vi.useFakeTimers();
    const { ctx } = fixture([[{ name: "  Cedar \n  Oaks  ", code: " ab-12 " }]]);
    const workflow: CollectionWorkflow = {
      ...recipe,
      before: [],
      pagination: null,
      extract: {
        items: ".item",
        fields: [
          {
            name: "name",
            selector: ".name",
            attribute: "text",
            required: true,
            normalize: "collapse",
          },
          {
            name: "code",
            selector: ".code",
            attribute: "text",
            required: true,
            normalize: "upper",
          },
          {
            name: "label",
            selector: ".name",
            attribute: "text",
            required: false,
            expression: "concat({name}, '/', {code})",
          },
        ],
      },
    };
    const pending = collectPages(ctx, { url: "https://example.com", workflow });
    await vi.runAllTimersAsync();
    const result = await pending;
    // Normalization runs before expressions, so concat sees the cleaned inputs.
    expect(result.records).toEqual([
      { name: "Cedar Oaks", code: " AB-12 ", label: "Cedar Oaks/ AB-12 " },
    ]);
  });

  it("drops only incomplete rows when the missing policy is row", async () => {
    vi.useFakeTimers();
    const { ctx, automation } = fixture([[]]);
    automation.extract.mockResolvedValue([{ name: "A" }, { name: "" }, { name: "B" }]);
    const workflow: CollectionWorkflow = {
      ...recipe,
      before: [],
      pagination: null,
      extract: { ...recipe.extract, missing: "row" },
    };
    const pending = collectPages(ctx, { url: "https://example.com", workflow });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.records).toEqual([{ name: "A" }, { name: "B" }]);
    // The policy travels to the browser port as part of the extraction input.
    expect(automation.extract).toHaveBeenCalledWith(
      expect.objectContaining({ missing: "row" }),
      expect.anything(),
    );
  });

  it("converts declared field types after expressions and failures fail the step", async () => {
    vi.useFakeTimers();
    const { ctx } = fixture([[{ name: "Cedar", price: " 18.50 ", active: "TRUE", rank: "2" }]]);
    const workflow: CollectionWorkflow = {
      ...recipe,
      before: [],
      pagination: null,
      extract: {
        items: ".item",
        fields: [
          { name: "name", selector: ".name", attribute: "text", required: true },
          { name: "price", selector: ".price", attribute: "text", required: true, type: "number" },
          {
            name: "active",
            selector: ".active",
            attribute: "text",
            required: true,
            type: "boolean",
          },
          { name: "rank", selector: ".rank", attribute: "text", required: true, type: "number" },
          {
            name: "label",
            selector: ".name",
            attribute: "text",
            required: false,
            expression: "concat({name}, '#', {rank})",
          },
        ],
      },
    };
    const pending = collectPages(ctx, { url: "https://example.com", workflow });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.records).toEqual([
      { name: "Cedar", price: 18.5, active: true, rank: 2, label: "Cedar#2" },
    ]);
  });

  it("rejects unparseable number fields as a step failure", async () => {
    vi.useFakeTimers();
    const { ctx } = fixture([[{ name: "Cedar", price: "N/A" }]]);
    const workflow: CollectionWorkflow = {
      ...recipe,
      before: [],
      pagination: null,
      extract: {
        items: ".item",
        fields: [
          { name: "name", selector: ".name", attribute: "text", required: true },
          { name: "price", selector: ".price", attribute: "text", required: true, type: "number" },
        ],
      },
    };
    const rejection = collectPages(ctx, { url: "https://example.com", workflow }).catch(
      (error: unknown) => error,
    );
    await vi.runAllTimersAsync();
    await expect(rejection).resolves.toBeInstanceOf(AppError);
  });

  it("falls back to the configured back control when browser history is unavailable", async () => {
    vi.useFakeTimers();
    const { ctx, automation } = fixture([[{ name: "Cedar" }]]);
    delete ctx.browser.goBack;
    automation.snapshotItems.mockResolvedValue(1);
    automation.extract
      .mockResolvedValueOnce([{ name: "Cedar" }])
      .mockResolvedValueOnce([{ price: "18.00" }])
      .mockResolvedValue([{ name: "Cedar" }]);
    const workflow: CollectionWorkflow = {
      ...recipe,
      before: [],
      pagination: null,
      detail: {
        link: ".detail-link",
        back: ".back",
        extract: {
          items: "main",
          fields: [{ name: "price", selector: ".price", attribute: "text", required: true }],
        },
        maxItems: 1,
      },
    };
    const pending = collectPages(ctx, { url: "https://example.com", workflow });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.records).toEqual([{ name: "Cedar", price: "18.00" }]);
    expect(automation.act).toHaveBeenCalledWith(
      { kind: "click", selector: ".back" },
      expect.anything(),
      expect.anything(),
    );
  });

  it("aborts a page wait without subsequent actions or inspection", async () => {
    vi.useFakeTimers();
    const { ctx, controller, automation } = fixture([[]]);
    const pending = collectPages(ctx, {
      url: "https://example.com",
      workflow: { ...recipe, before: [] },
    });
    const assertion = expect(pending).rejects.toThrow("CANCELLED");
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(new AppError("CANCELLED"));
    await vi.runAllTimersAsync();
    await assertion;
    expect(automation.act).not.toHaveBeenCalled();
    expect(ctx.browser.inspect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects absent parameters before navigating", async () => {
    const { ctx } = fixture([[{ name: "A" }]]);
    await expect(
      collectPages(ctx, { url: "https://example.com", workflow: recipe }),
    ).rejects.toThrow("INVALID_INPUT");
    expect(ctx.browser.navigate).not.toHaveBeenCalled();
  });
});
