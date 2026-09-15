import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import type { CollectionWorkflow } from "@clawler/contracts";
import { type ElectronApplication, expect, test } from "@playwright/test";

async function ready(application: ElectronApplication) {
  await expect
    .poll(() => application.windows().some((page) => page.url().startsWith("clawler-app://ui/")))
    .toBe(true);
  const page = application.windows().find((entry) => entry.url().startsWith("clawler-app://ui/"));
  if (!page) throw new Error("Missing UI");
  return page;
}

function page(body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Catalog</title><style>
body{font-family:system-ui;margin:30px}
.row,.variant{border:1px solid #ddd;border-radius:8px;padding:12px;margin-bottom:8px}
a{color:#4a7c59}
</style>${body}`;
}

test("nested traversal extracts detail-page rows and opens their child pages in a real browser", async ({
  playwright,
}, testInfo) => {
  test.setTimeout(90_000);
  // One list row -> its detail page hosts a nested variant list -> each variant links to a child page.
  const site = createServer((request, response) => {
    const path = request.url ?? "/";
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (path === "/") {
      response.end(
        page(
          `<div class="row"><span class="name">Cedar</span> <a class="detail-link" href="/item/1/">open</a></div>`,
        ),
      );
      return;
    }
    if (path === "/item/1/") {
      response.end(
        page(`<h1 class="title">Cedar</h1><p class="price">18.00</p>
<div class="variant"><span class="sku">A1</span> <a class="child-link" href="/item/1/variant/1/">open</a></div>
<div class="variant"><span class="sku">A2</span> <a class="child-link" href="/item/1/variant/2/">open</a></div>
<a class="back" href="/">back</a>`),
      );
      return;
    }
    const match = /^\/item\/1\/variant\/(\d+)\/$/.exec(path);
    if (match) {
      response.end(
        page(
          `<p class="stock">${match[1] === "1" ? "7" : "3"}</p><a class="back" href="/item/1/">back</a>`,
        ),
      );
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const address = site.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const targetUrl = `http://127.0.0.1:${address.port}/`;
  const dataDirectory = testInfo.outputPath("user-data");
  await mkdir(dataDirectory, { recursive: true });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  env.CLAWLER_TEST = "1";
  env.CLAWLER_DATA_DIR = dataDirectory;
  env.CLAWLER_GATEWAY_TOKEN = "nested-traversal-token-at-least-thirty-two-chars";
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
  const endpoint = reservation.address();
  if (!endpoint || typeof endpoint === "string") throw new Error("Missing gateway port");
  await new Promise<void>((done) => reservation.close(() => done()));
  env.CLAWLER_GATEWAY_PORT = String(endpoint.port);
  const application = await playwright._electron.launch({ args: [resolve("apps/desktop")], env });
  try {
    const ui = await ready(application);
    await ui.locator(".instance-main").first().click();
    const workspace = await ui.evaluate(() => window.clawler?.getWorkspace());
    const instance = workspace?.instances[0];
    if (!instance) throw new Error("Missing instance");

    const workflow: CollectionWorkflow = {
      version: 1,
      before: [],
      extract: {
        items: ".row",
        fields: [{ name: "name", selector: ".name", attribute: "text", required: true }],
      },
      pagination: null,
      detail: {
        link: ".detail-link",
        extract: {
          items: "body",
          fields: [
            { name: "price", selector: ".price", attribute: "text", required: true },
            { name: "material", selector: ".title", attribute: "text", required: false },
          ],
        },
        rows: {
          items: ".variant",
          fields: [{ name: "sku", selector: ".sku", attribute: "text", required: true }],
        },
        children: {
          link: ".child-link",
          extract: {
            items: "body",
            fields: [{ name: "stock", selector: ".stock", attribute: "text", required: true }],
          },
          back: ".back",
          maxItems: 10,
        },
        maxItems: 10,
      },
      waitTimeoutMs: 3000,
      maxRecords: 10,
      dedupe: [],
    };
    await ui.evaluate(
      ({ id, recipe, url, profileId }) =>
        window.clawler?.saveWorkflow(id, recipe, {
          name: "Nested catalog",
          targetUrl: url,
          profileId,
          enabled: true,
        }),
      { id: instance.id, recipe: workflow, url: targetUrl, profileId: instance.profileId },
    );
    await ui.evaluate((id) => window.clawler?.publishWorkflow(id), instance.id);
    await ui.evaluate((id) => window.clawler?.startRun(id), instance.id);
    await expect
      .poll(() => ui.evaluate(async () => (await window.clawler?.getWorkspace())?.runs[0]?.status))
      .toBe("succeeded");
    const result = await ui.evaluate(async () => {
      const snapshot = await window.clawler?.getWorkspace();
      return snapshot?.runs[0]?.result;
    });
    // The merged list row, then each nested variant record enriched by its own child page.
    expect(result?.records).toEqual([
      { name: "Cedar", price: "18.00", material: "Cedar" },
      { sku: "A1", stock: "7" },
      { sku: "A2", stock: "3" },
    ]);
    expect(result?.collection).toEqual({ pages: 1, stopReason: "single-page", truncated: false });
    // The traversal returns all the way back to the list page.
    expect(result?.url).toBe(targetUrl);
    await ui.screenshot({ path: testInfo.outputPath("nested-traversal-zh.png") });
  } finally {
    await application.close();
    await new Promise<void>((done) => site.close(() => done()));
  }
});
