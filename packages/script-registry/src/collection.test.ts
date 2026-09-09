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

function fixture(pages: Array<Array<Record<string, string>>>, sameUrl = false) {
  let index = 0;
  const controller = new AbortController();
  const steps: StepKind[] = [];
  const automation = {
    act: vi.fn(async (action: { kind: string; selector: string }) => {
      if (action.selector === ".next") index++;
    }),
    extract: vi.fn(async () => pages[index] ?? []),
    hasNext: vi.fn(async () => index < pages.length - 1),
  };
  const ctx: ScriptContext = {
    signal: controller.signal,
    browser: {
      automation,
      navigate: vi.fn(async () => undefined),
      inspect: vi.fn(async () => {
        let url = `https://example.com/${index}`;
        if (sameUrl) url = "https://example.com/";
        return { url, title: "Test", headings: [], links: [] };
      }),
    },
    async step(kind, action) {
      steps.push(kind);
      return action();
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
    expect(steps).toEqual(["navigate", "fill", "click", "extract", "click", "extract", "inspect"]);
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
    await assertion;
    await vi.runAllTimersAsync();
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
