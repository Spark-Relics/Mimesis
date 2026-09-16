import { mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import type { CollectionWorkflow } from "@clawler/contracts";
import { type ElectronApplication, expect, test } from "@playwright/test";

type Playwright = Parameters<Parameters<typeof test>[2]>[0]["playwright"];

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

// Three HTML list pages plus a cursor API: each cursor call returns the link to
// the page after the last served list page, then reports exhaustion.
function startCursorSite(): Server {
  let lastPage = 0;
  let sitePort = 0;
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    if (/^\/cursor\/?$/.test(path)) {
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      const next = lastPage + 1;
      // The handler only runs after listen() fills in the real port.
      // The exhaustion body must not match the pattern (no "next=<link>").
      if (next >= 4) response.end('{"next":null}');
      else response.end(`next=http://127.0.0.1:${sitePort}/list/${next}`);
      return;
    }
    const match = /^\/list\/(\d+)\/?$/.exec(path);
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (match) {
      const number = Number(match[1]);
      lastPage = number;
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
  server.on("listening", () => {
    const address = server.address();
    if (address && typeof address !== "string") sitePort = address.port;
  });
  return server;
}

async function launch(testInfo: { outputPath: (name: string) => string }, playwright: Playwright) {
  const site = startCursorSite();
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const address = site.address();
  if (!address || typeof address === "string") throw new Error("Missing site port");
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
  env.CLAWLER_GATEWAY_TOKEN = "cursor-pagination-token-at-least-thirty-chars";
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
  const endpoint = reservation.address();
  if (!endpoint || typeof endpoint === "string") throw new Error("Missing gateway port");
  await new Promise<void>((done) => reservation.close(() => done()));
  env.CLAWLER_GATEWAY_PORT = String(endpoint.port);
  const application = await playwright._electron.launch({ args: [resolve("apps/desktop")], env });
  return { site, port: address.port, application };
}

async function runCursorWorkflow(
  ui: Awaited<ReturnType<typeof ready>>,
  port: number,
  maxPages: number,
) {
  const workspace = await ui.evaluate(() => window.clawler?.getWorkspace());
  const instance = workspace?.instances[0];
  if (!instance) throw new Error("Missing instance");
  const targetUrl = `http://127.0.0.1:${port}/list/1`;
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
      cursor: {
        request: {
          method: "GET",
          url: `http://127.0.0.1:${port}/cursor`,
          headers: {},
          timeoutMs: 5000,
          expectStatus: 200,
        },
        pattern: "next=(\\S+)",
      },
      maxPages,
    },
    waitTimeoutMs: 3000,
    maxRecords: 50,
    dedupe: [],
  };
  await ui.evaluate(
    ({ id, recipe, url, profileId }) =>
      window.clawler?.saveWorkflow(id, recipe, {
        name: "Cursor catalog",
        targetUrl: url,
        profileId,
        enabled: true,
      }),
    { id: instance.id, recipe: workflow, url: targetUrl, profileId: instance.profileId },
  );
  await ui.evaluate((id) => window.clawler?.publishWorkflow(id), instance.id);
  await ui.evaluate((id) => window.clawler?.startRun(id), instance.id);
}

async function waitForRun(ui: Awaited<ReturnType<typeof ready>>) {
  await expect
    .poll(() => ui.evaluate(async () => (await window.clawler?.getWorkspace())?.runs[0]?.status))
    .toBe("succeeded");
  const snapshot = await ui.evaluate(async () => await window.clawler?.getWorkspace());
  return { result: snapshot?.runs[0]?.result, steps: snapshot?.runs[0]?.steps ?? [] };
}

test("cursor pagination follows API links and stops when the cursor is exhausted", async ({
  playwright,
}, testInfo) => {
  test.setTimeout(120_000);
  const { site, port, application } = await launch(testInfo, playwright);
  try {
    const ui = await ready(application);
    await ui.locator(".instance-main").first().click();
    await runCursorWorkflow(ui, port, 5);
    const { result, steps } = await waitForRun(ui);
    expect(result?.records).toEqual([
      { name: "Item 1a", pageNumber: "1" },
      { name: "Item 1b", pageNumber: "1" },
      { name: "Item 2a", pageNumber: "2" },
      { name: "Item 2b", pageNumber: "2" },
      { name: "Item 3a", pageNumber: "3" },
      { name: "Item 3b", pageNumber: "3" },
    ]);
    expect(result?.collection).toEqual({
      pages: 3,
      stopReason: "cursor-exhausted",
      truncated: false,
    });
    // The run ends on the last fetched page.
    expect(result?.url).toBe(`http://127.0.0.1:${port}/list/3`);
    // A request step runs after each page's extraction; no click actions.
    expect(steps.filter((step) => step.kind === "request").length).toBe(3);
    expect(steps.some((step) => step.kind === "click")).toBe(false);
    await ui.screenshot({ path: testInfo.outputPath("cursor-pagination-zh.png") });
  } finally {
    await application.close();
    await new Promise<void>((done) => site.close(() => done()));
  }
});

test("cursor pagination stops at maxPages before issuing the extra request", async ({
  playwright,
}, testInfo) => {
  test.setTimeout(120_000);
  const { site, port, application } = await launch(testInfo, playwright);
  try {
    const ui = await ready(application);
    await ui.locator(".instance-main").first().click();
    await runCursorWorkflow(ui, port, 2);
    const { result, steps } = await waitForRun(ui);
    expect(result?.records).toEqual([
      { name: "Item 1a", pageNumber: "1" },
      { name: "Item 1b", pageNumber: "1" },
      { name: "Item 2a", pageNumber: "2" },
      { name: "Item 2b", pageNumber: "2" },
    ]);
    expect(result?.collection).toEqual({ pages: 2, stopReason: "page-limit", truncated: true });
    // The limit stops the run before requesting a cursor past page 2.
    expect(steps.filter((step) => step.kind === "request").length).toBe(1);
    expect(steps.some((step) => step.kind === "click")).toBe(false);
    await ui.screenshot({ path: testInfo.outputPath("cursor-pagination-limit-zh.png") });
  } finally {
    await application.close();
    await new Promise<void>((done) => site.close(() => done()));
  }
});
