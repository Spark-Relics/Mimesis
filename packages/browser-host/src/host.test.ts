import { AppError, type PageStructure, structureSchema } from "@clawler/contracts";
import type { BrowserWindow, WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserHost } from "./index";
import { highlightElements, observeStructure } from "./observe-script";

const listPage = `<main class="catalog"><section class="results">
<article class="product"><h2 class="title">Alpha</h2><a class="link" href="/a">Open</a><img class="thumb" src="/a.png"></article>
<article class="product"><h2 class="title">Beta</h2><a class="link" href="/b">Open</a><img class="thumb" src="/b.png"></article>
<article class="product"><h2 class="title">Gamma</h2><a class="link" href="/c">Open</a><img class="thumb" src="/c.png"></article>
</section></main><nav class="pager"><a class="next" href="/page/2">Next</a></nav>`;

/**
 * happy-dom provides the DOM query surface the observe script uses, so its
 * heuristics can be exercised without a real browser. The environment switch is
 * scoped to this file to keep the rest of the suite in node.
 */
// @vitest-environment happy-dom
function stubDocument(html: string) {
  document.head.innerHTML = "";
  document.body.innerHTML = html;
}

describe("structure observation heuristics", () => {
  afterEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("proposes list fields and a next-page control from a repeated structure", () => {
    stubDocument(listPage);
    const structure = structureSchema.parse(observeStructure());
    expect(structure.lists).toHaveLength(1);
    const list = structure.lists[0] as PageStructure["lists"][number];
    // The item selector addresses the repeated rows, one record each.
    expect(list.itemSelector).toBe("body > main.catalog > section.results > article.product");
    expect(list.fields.map((field) => field.name)).toEqual(["title", "link", "thumb"]);
    expect(list.fields[0]?.samples).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(structure.pagination.at(0)?.label).toBe("next");
  });

  it("reports no candidates on a page without repeated structures", () => {
    stubDocument("<h1>Hello</h1>");
    expect(structureSchema.parse(observeStructure()).lists).toEqual([]);
  });
});

describe("selector highlighting", () => {
  afterEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  it("marks matched elements and clears them again", () => {
    stubDocument(listPage);
    expect(highlightElements(".product")).toMatchObject({ count: 3 });
    expect(highlightElements("")).toMatchObject({ count: 0 });
  });

  it("ignores an invalid selector instead of throwing", () => {
    stubDocument(listPage);
    expect(highlightElements("!!!")).toMatchObject({ count: 0 });
  });
});

/** Host plumbing needs a contents handle, which the view machinery otherwise owns. */
function hostWith(contents: WebContents): BrowserHost {
  const host = new BrowserHost({} as BrowserWindow);
  // getContents is private and throws without a selected view; supply the stub directly.
  Object.defineProperty(host, "current", {
    value: { webContents: contents },
    configurable: true,
  });
  return host;
}

/** Contents stub with the surface observe/highlight touch: debugger + liveness. */
function contentsWith(sendCommand: (command: string, args: unknown) => Promise<unknown>) {
  return {
    debugger: { isAttached: () => true, sendCommand },
    isDestroyed: () => false,
  } as unknown as WebContents;
}

describe("browser host observe/highlight plumbing", () => {
  it("parses the page response into a validated structure", async () => {
    const value: PageStructure = {
      url: "https://example.test/page/1",
      lists: [],
      pagination: [{ selector: ".next", label: "next" }],
    };
    const sendCommand = vi.fn(async () => ({ result: { value } }));
    const host = hostWith(contentsWith(sendCommand));
    const structure = await host.observe(new AbortController().signal);
    expect(structure).toEqual(value);
  });

  it("rejects a page exception as invalid input", async () => {
    const sendCommand = vi.fn(async () => ({ result: { value: null }, exceptionDetails: {} }));
    const host = hostWith(contentsWith(sendCommand));
    await expect(host.observe(new AbortController().signal)).rejects.toThrow("INVALID_INPUT");
  });

  it("signals when a highlighted selector matches nothing", async () => {
    const sendCommand = vi.fn(async () => ({ result: { value: { count: 0 } } }));
    const host = hostWith(contentsWith(sendCommand));
    await expect(host.highlight(".missing", new AbortController().signal)).rejects.toThrow(
      "NOT_FOUND",
    );
    await expect(host.highlight("", new AbortController().signal)).resolves.toBeUndefined();
  });

  it("aborts observation when the run is cancelled", async () => {
    const host = hostWith(contentsWith(vi.fn()));
    const controller = new AbortController();
    controller.abort(new AppError("CANCELLED"));
    await expect(host.observe(controller.signal)).rejects.toThrow("CANCELLED");
  });
});
