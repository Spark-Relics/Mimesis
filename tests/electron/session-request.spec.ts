import { mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import type { CollectionWorkflow } from "@clawler/contracts";
import { type ElectronApplication, expect, test } from "@playwright/test";

type Playwright = Parameters<Parameters<typeof test>[2]>[0]["playwright"];

const COOKIE = "mimesis-session=verified";

function listBody(number: number): string {
  return `<!doctype html><meta charset="utf-8"><title>Members</title><style>
body{font-family:system-ui;margin:30px}
.row{border:1px solid #ddd;border-radius:8px;padding:12px;margin-bottom:8px}
</style>
<div class="row"><span class="name">Member ${number}a</span> <span class="page">${number}</span></div>
<div class="row"><span class="name">Member ${number}b</span> <span class="page">${number}</span></div>`;
}

/** Login-gated site: /login seeds the profile cookie, lists and the cursor API refuse requests without it. */
function startSessionSite(): { server: Server; seenCookieOnCursor: () => boolean } {
  let sitePort = 0;
  let lastPage = 0;
  let cookieSeen = false;
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    const authorized = (request.headers.cookie ?? "").includes(COOKIE);
    if (/^\/login\/?$/.test(path)) {
      response.setHeader("Set-Cookie", `${COOKIE}; Path=/; HttpOnly`);
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end("<!doctype html><title>Sign in</title><p>Signed in.</p>");
      return;
    }
    if (!authorized) {
      response.statusCode = 403;
      response.end("forbidden");
      return;
    }
    if (/^\/cursor\/?$/.test(path)) {
      cookieSeen = true;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      const next = lastPage + 1;
      if (next >= 4) response.end('{"next":null}');
      else response.end(`next=http://127.0.0.1:${sitePort}/list/${next}`);
      return;
    }
    const match = /^\/list\/(\d+)\/?$/.exec(path);
    if (match) {
      const number = Number(match[1]);
      lastPage = number;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(listBody(number));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  server.on("listening", () => {
    const address = server.address();
    if (address && typeof address !== "string") sitePort = address.port;
  });
  return { server, seenCookieOnCursor: () => cookieSeen };
}

async function launch(testInfo: { outputPath: (name: string) => string }, playwright: Playwright) {
  const site = startSessionSite();
  await new Promise<void>((done) => site.server.listen(0, "127.0.0.1", done));
  const address = site.server.address();
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
  env.CLAWLER_GATEWAY_TOKEN = "session-request-token-at-least-thirty-characters";
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
  const endpoint = reservation.address();
  if (!endpoint || typeof endpoint === "string") throw new Error("Missing gateway port");
  await new Promise<void>((done) => reservation.close(() => done()));
  env.CLAWLER_GATEWAY_PORT = String(endpoint.port);
  const application = await playwright._electron.launch({ args: [resolve("apps/desktop")], env });
  return { site, port: address.port, application };
}

async function ready(application: ElectronApplication) {
  await expect
    .poll(() => application.windows().some((page) => page.url().startsWith("clawler-app://ui/")))
    .toBe(true);
  const page = application.windows().find((entry) => entry.url().startsWith("clawler-app://ui/"));
  if (!page) throw new Error("Missing UI");
  return page;
}

/** Opens /login in the embedded browser so the profile session holds the auth cookie. */
async function signIn(
  application: ElectronApplication,
  ui: Awaited<ReturnType<typeof ready>>,
  port: number,
) {
  const loginUrl = `http://127.0.0.1:${port}/login`;
  await ui.getByRole("textbox", { name: "浏览器地址" }).fill(loginUrl);
  await ui.getByRole("button", { name: "打开网址", exact: true }).click();
  await expect
    .poll(() =>
      application
        .context()
        .pages()
        .some((page) => page.url() === loginUrl),
    )
    .toBe(true);
  // Let the cookie settle into the session storage before any request uses it.
  await ui.waitForTimeout(500);
}

async function runCursorWorkflow(
  ui: Awaited<ReturnType<typeof ready>>,
  port: number,
  useSession: boolean,
) {
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
      cursor: {
        request: {
          method: "GET",
          url: `http://127.0.0.1:${port}/cursor`,
          headers: {},
          timeoutMs: 5000,
          expectStatus: 200,
          ...(useSession && { useSession: true }),
        },
        pattern: "next=(\\S+)",
      },
      maxPages: 5,
    },
    waitTimeoutMs: 3000,
    maxRecords: 50,
    dedupe: [],
  };
  await ui.evaluate(
    ({ id, recipe, url, profileId }) =>
      window.clawler?.saveWorkflow(id, recipe, {
        name: "Session members",
        targetUrl: url,
        profileId,
        enabled: true,
      }),
    {
      id: instance.id,
      recipe: workflow,
      url: `http://127.0.0.1:${port}/list/1`,
      profileId: instance.profileId,
    },
  );
  await ui.evaluate((id) => window.clawler?.publishWorkflow(id), instance.id);
  await ui.evaluate((id) => window.clawler?.startRun(id), instance.id);
}

async function readRun(ui: Awaited<ReturnType<typeof ready>>) {
  const snapshot = await ui.evaluate(async () => await window.clawler?.getWorkspace());
  return {
    status: snapshot?.runs[0]?.status,
    result: snapshot?.runs[0]?.result,
    steps: snapshot?.runs[0]?.steps ?? [],
  };
}

test("useSession cursor requests carry the browser profile login cookie", async ({
  playwright,
}, testInfo) => {
  test.setTimeout(120_000);
  const { site, port, application } = await launch(testInfo, playwright);
  try {
    const ui = await ready(application);
    await ui.locator(".instance-main").first().click();
    await signIn(application, ui, port);
    await runCursorWorkflow(ui, port, true);
    await expect
      .poll(() => ui.evaluate(async () => (await window.clawler?.getWorkspace())?.runs[0]?.status))
      .toBe("succeeded");
    const { result, steps } = await readRun(ui);
    expect(result?.records).toEqual([
      { name: "Member 1a", pageNumber: "1" },
      { name: "Member 1b", pageNumber: "1" },
      { name: "Member 2a", pageNumber: "2" },
      { name: "Member 2b", pageNumber: "2" },
      { name: "Member 3a", pageNumber: "3" },
      { name: "Member 3b", pageNumber: "3" },
    ]);
    expect(result?.collection).toEqual({
      pages: 3,
      stopReason: "cursor-exhausted",
      truncated: false,
    });
    // The cursor API is cookie-gated, so reaching it proves the session cookie was attached.
    expect(steps.filter((step) => step.kind === "request").length).toBe(3);
    expect(site.seenCookieOnCursor()).toBe(true);
    await ui.screenshot({ path: testInfo.outputPath("session-request-zh.png") });
  } finally {
    await application.close();
    await new Promise<void>((done) => site.server.close(() => done()));
  }
});

test("isolated cursor requests miss the login cookie and fail REQUEST_FAILED", async ({
  playwright,
}, testInfo) => {
  test.setTimeout(120_000);
  const { site, port, application } = await launch(testInfo, playwright);
  try {
    const ui = await ready(application);
    await ui.locator(".instance-main").first().click();
    await signIn(application, ui, port);
    await runCursorWorkflow(ui, port, false);
    await expect
      .poll(() => ui.evaluate(async () => (await window.clawler?.getWorkspace())?.runs[0]?.status))
      .toBe("failed");
    const { result, steps } = await readRun(ui);
    // Page 1 extracts fine (the browser itself is signed in); the isolated
    // cursor request gets 403 and fails the run.
    expect(result?.collection?.stopReason).toBeUndefined();
    const request = steps.find((step) => step.kind === "request");
    expect(request?.status).toBe("failed");
    expect(request?.errorCode).toBe("REQUEST_FAILED");
    // The cookie-gated cursor endpoint never saw an authorized isolated request.
    expect(site.seenCookieOnCursor()).toBe(false);
    await ui.screenshot({ path: testInfo.outputPath("session-request-failed-zh.png") });
  } finally {
    await application.close();
    await new Promise<void>((done) => site.server.close(() => done()));
  }
});
