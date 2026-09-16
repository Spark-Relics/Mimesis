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
</style>${body}`;
}

test("URL-template pagination walks every page via the page cursor and stops at maxPages", async ({
  playwright,
}, testInfo) => {
  test.setTimeout(90_000);
  // Three pages addressed by /list/<n>; each row carries its page number so the
  // collected order proves which pages were visited.
  const site = createServer((request, response) => {
    const path = request.url ?? "/";
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    const match = /^\/list\/(\d+)\/?$/.exec(path);
    if (match) {
      const number = Number(match[1]);
      response.end(
        page(
          `<div class="row"><span class="name">Item ${number}a</span> <span class="page">${number}</span></div>
<div class="row"><span class="name">Item ${number}b</span> <span class="page">${number}</span></div>`,
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
  const targetUrl = `http://127.0.0.1:${address.port}/list/1`;
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
  env.CLAWLER_GATEWAY_TOKEN = "url-pagination-token-at-least-thirty-two-chars";
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
        fields: [
          { name: "name", selector: ".name", attribute: "text", required: true },
          { name: "pageNumber", selector: ".page", attribute: "text", required: true },
        ],
      },
      pagination: {
        urlTemplate: `http://127.0.0.1:${address.port}/list/{{page}}`,
        startPage: 1,
        maxPages: 3,
      },
      waitTimeoutMs: 3000,
      maxRecords: 50,
      dedupe: [],
    };
    await ui.evaluate(
      ({ id, recipe, url, profileId }) =>
        window.clawler?.saveWorkflow(id, recipe, {
          name: "Paged catalog",
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
      { name: "Item 1a", pageNumber: "1" },
      { name: "Item 1b", pageNumber: "1" },
      { name: "Item 2a", pageNumber: "2" },
      { name: "Item 2b", pageNumber: "2" },
      { name: "Item 3a", pageNumber: "3" },
      { name: "Item 3b", pageNumber: "3" },
    ]);
    expect(result?.collection).toEqual({ pages: 3, stopReason: "page-limit", truncated: true });
    // The run ends on the last fetched page.
    expect(result?.url).toBe(`http://127.0.0.1:${address.port}/list/3`);
    const steps = await ui.evaluate(async () => {
      const snapshot = await window.clawler?.getWorkspace();
      return snapshot?.runs[0]?.steps ?? [];
    });
    // No pagination click actions; pages arrive via navigate steps (initial + cursor pages).
    const navigations = steps.filter((step) => step.kind === "navigate");
    expect(navigations.map((step) => step.detail)).toEqual([
      `http://127.0.0.1:${address.port}/list/1`,
      `http://127.0.0.1:${address.port}/list/2`,
      `http://127.0.0.1:${address.port}/list/3`,
    ]);
    expect(steps.some((step) => step.kind === "click")).toBe(false);
    await ui.screenshot({ path: testInfo.outputPath("url-pagination-zh.png") });
  } finally {
    await application.close();
    await new Promise<void>((done) => site.close(() => done()));
  }
});
