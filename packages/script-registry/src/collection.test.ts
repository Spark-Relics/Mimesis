import { AppError, type CollectionWorkflow, type StepKind } from "@clawler/contracts";
import type { ScriptContext } from "@clawler/script-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectPages, resolveWorkflow } from "./collection";

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
    act: vi.fn(async (action: { kind: string; selector: string }) => {
      if (failOn && action.selector === failOn) throw new AppError("TIMEOUT");
      if (action.selector === ".next") index++;
    }),
    extract: vi.fn(async () => pages[index] ?? []),
    snapshotItems: vi.fn(async () => 0),
    actOnItem: vi.fn(async (_index: number) => undefined),
    exists: vi.fn(async (selector: string) => {
      if (present) return present.includes(selector);
      return index < pages.length - 1;
    }),
  };
  const ctx: ScriptContext = {
    signal: controller.signal,
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
  return { ctx, automation, controller, steps };
}

afterEach(() => vi.useRealTimers());

describe("reusable collection interpreter", () => {
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
    expect(automation.act.mock.calls.map(([action]) => action.selector)).toEqual([
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
    expect(automation.act.mock.calls.map(([action]) => action.selector)).toEqual([
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
