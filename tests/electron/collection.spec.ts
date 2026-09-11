import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import type { CollectionWorkflow } from "@clawler/contracts";
import { expect, test } from "@playwright/test";
import { readRuntime } from "./runtime.test-support";

test("record native actions, configure loop, execute with parameters and export through gateway", async ({
  playwright,
}, testInfo) => {
  test.setTimeout(90_000);
  const site = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const keyword = url.searchParams.get("keyword") ?? "";
    const pageNumber = Number(url.pathname.split("/").at(-1));
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (!pageNumber) {
      response.end(
        '<!doctype html><title>Recording fixture</title><form action="/page/1"><input id="search" name="keyword"><input id="password" type="password"><button id="submit">Search</button></form><script>document.querySelector("form").addEventListener("submit",e=>{if(!e.isTrusted)e.preventDefault()})</script>',
      );
      return;
    }
    const rows = [1, 2]
      .map(
        (item) =>
          `<article class="quote"><span class="text">${keyword.replaceAll("<", "&lt;")} ${pageNumber}-${item}</span><span class="author">Author ${item}</span></article>`,
      )
      .join("");
    let next = "";
    if (pageNumber === 1)
      next = `<a id="next" href="/page/2?keyword=${encodeURIComponent(keyword)}">Next</a>`;
    response.end(`<!doctype html><title>Collection fixture</title>${rows}${next}`);
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
  env.CLAWLER_GATEWAY_TOKEN = "collection-test-token-at-least-thirty-two-characters";
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
  const endpoint = reservation.address();
  if (!endpoint || typeof endpoint === "string") throw new Error("Missing gateway port");
  await new Promise<void>((done) => reservation.close(() => done()));
  env.CLAWLER_GATEWAY_PORT = String(endpoint.port);
  const application = await playwright._electron.launch({ args: [resolve("apps/desktop")], env });
  try {
    await expect
      .poll(() => application.windows().some((page) => page.url().startsWith("clawler-app:")))
      .toBe(true);
    const ui = application.windows().find((page) => page.url().startsWith("clawler-app:"));
    if (!ui) throw new Error("Missing UI");
    await ui.locator(".instance-main").first().click();
    await ui.getByRole("textbox", { name: "浏览器地址" }).fill(targetUrl);
    await ui.getByRole("button", { name: "打开网址", exact: true }).click();
    await expect
      .poll(() =>
        application
          .context()
          .pages()
          .some((page) => page.url() === targetUrl),
      )
      .toBe(true);
    const browser = application
      .context()
      .pages()
      .find((page) => page.url() === targetUrl);
    if (!browser) throw new Error("Missing embedded page");
    await ui.getByRole("button", { name: "开始录制", exact: true }).click();
    await expect(ui.getByRole("button", { name: "结束并整理步骤" })).toBeEnabled();
    await browser.locator("#search").fill("alpha");
    await browser.locator("#password").fill("never-store-this");
    await browser.locator("#submit").click();
    await browser.locator("#next").click();
    await expect(browser.locator(".quote")).toHaveCount(2);
    await ui.getByRole("button", { name: "结束并整理步骤" }).click();
    await expect(ui.locator(".recorded-actions li")).toHaveCount(3);
    await expect(ui.getByRole("status")).toContainText("跳过 1");
    await ui.getByRole("button", { name: "将最后一次点击设为下一页循环" }).click();
    await expect(ui.locator(".recorded-actions li")).toHaveCount(2);
    await ui.getByText("流程脚本（JSON）", { exact: true }).click();
    const source = ui.getByRole("textbox", { name: "流程脚本（JSON）", exact: true });
    await expect(source).toHaveValue(/"version"/u);
    const recorded: CollectionWorkflow = JSON.parse(await source.inputValue());
    expect(recorded.before).toEqual([
      { kind: "fill", selector: "#search", value: "alpha" },
      { kind: "click", selector: "#submit" },
    ]);
    expect(recorded.pagination?.next).toBe("#next");
    expect(JSON.stringify(recorded)).not.toContain("never-store-this");
    const fill = recorded.before[0];
    if (fill?.kind !== "fill") throw new Error("Expected fill");
    fill.value = "{{keyword}}";
    recorded.extract = {
      items: ".quote",
      fields: [
        { name: "quote", selector: ".text", attribute: "text", required: true },
        { name: "author", selector: ".author", attribute: "text", required: true },
      ],
    };
    await source.fill(JSON.stringify(recorded, null, 2));
    await ui.getByRole("button", { name: "应用脚本", exact: true }).click();
    await ui.getByRole("textbox", { name: "本次运行参数（JSON）" }).fill('{"keyword":"beta"}');
    await ui.getByRole("button", { name: "保存并试跑", exact: true }).click();
    await expect
      .poll(async () => (await ui.evaluate(() => window.clawler?.getWorkspace()))?.runs[0]?.status)
      .toBe("succeeded");
    const workspace = await ui.evaluate(() => window.clawler?.getWorkspace());
    const run = workspace?.runs[0];
    expect(run?.result?.records?.map((row) => row.quote)).toEqual([
      "beta 1-1",
      "beta 1-2",
      "beta 2-1",
      "beta 2-2",
    ]);
    expect(run?.result?.collection).toEqual({
      pages: 2,
      stopReason: "next-unavailable",
      truncated: false,
    });
    expect(run?.steps.filter((step) => step.kind === "fill")).toHaveLength(1);
    await ui.screenshot({ path: testInfo.outputPath("collection-results.png") });
    await ui.locator(".instance-tab").nth(1).click();
    await ui.screenshot({ path: testInfo.outputPath("collection-workflow.png") });
    const api = (path: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${endpoint.port}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${env.CLAWLER_GATEWAY_TOKEN}`,
          "Content-Type": "application/json",
        },
      });
    const accepted = await api("/v1/jobs", {
      method: "POST",
      body: JSON.stringify({
        instanceId: workspace?.instances[0]?.id,
        parameters: { keyword: "gamma" },
      }),
    });
    expect(accepted.status).toBe(202);
    const { job } = await accepted.json();
    await expect
      .poll(async () => (await (await api(`/v1/jobs/${job.id}`)).json()).job.status)
      .toBe("succeeded");
    const result = await (await api(`/v1/jobs/${job.id}/result`)).json();
    expect(result.records[0].quote).toBe("gamma 1-1");
    expect(await (await api(`/v1/jobs/${job.id}/result?format=csv`)).text()).toContain("gamma 2-2");
    expect(
      (await (await api(`/v1/jobs/${job.id}/result?format=ndjson`)).text()).trim().split("\n"),
    ).toHaveLength(4);
    const saved = JSON.stringify(readRuntime(dataDirectory, "SELECT workflow FROM instances"));
    expect(saved).not.toContain("never-store-this");
    await writeFile(
      testInfo.outputPath("recorded-workflow.json"),
      JSON.stringify(recorded, null, 2),
    );
  } finally {
    await application.close();
    site.closeAllConnections();
    await new Promise<void>((done) => site.close(() => done()));
  }
});
