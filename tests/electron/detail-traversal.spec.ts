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
.row{border:1px solid #ddd;border-radius:8px;padding:12px;margin-bottom:8px}
a{color:#4a7c59}
</style>${body}`;
}

test("detail traversal opens each row, merges detail fields and returns to the list", async ({
  playwright,
}, testInfo) => {
  test.setTimeout(90_000);
  // A list page whose rows link to detail pages; the detail text proves which page was read.
  const site = createServer((request, response) => {
    const path = request.url ?? "/";
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (path === "/") {
      response.end(
        page(`<div class="row"><span class="name">Cedar</span> <a class="detail-link" href="/item/1/">open</a></div>
<div class="row"><span class="name">Birch</span> <a class="detail-link" href="/item/2/">open</a></div>`),
      );
      return;
    }
    const match = /^\/item\/(\d+)\/$/.exec(path);
    if (match) {
      response.end(
        page(`<h1 class="title">${["Cedar", "Birch"][Number(match[1]) - 1]}</h1>
<p class="price">${Number(match[1]) === 1 ? "18.00" : "12.50"}</p><a class="back" href="/">back</a>`),
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
  env.CLAWLER_GATEWAY_TOKEN = "detail-traversal-token-at-least-thirty-two-chars";
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
        maxItems: 10,
      },
      waitTimeoutMs: 3000,
      maxRecords: 10,
      dedupe: [],
    };
    await ui.evaluate(
      ({ id, recipe, url, profileId }) =>
        window.clawler?.saveWorkflow(id, recipe, {
          name: "Detail catalog",
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
    expect(result?.records).toEqual([
      { name: "Cedar", price: "18.00", material: "Cedar" },
      { name: "Birch", price: "12.50", material: "Birch" },
    ]);
    expect(result?.collection).toEqual({ pages: 1, stopReason: "single-page", truncated: false });
    // After traversal the run ends back on the list page.
    expect(result?.url).toBe(targetUrl);
    await ui.screenshot({ path: testInfo.outputPath("detail-traversal-zh.png") });
  } finally {
    await application.close();
    await new Promise<void>((done) => site.close(() => done()));
  }
});
