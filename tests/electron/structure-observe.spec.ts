import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * Structure observation regression on a controlled local site: the deterministic
 * scan proposes list/field/pagination candidates, the live highlight outlines the
 * matched rows in the embedded browser, and applying the proposal produces a
 * workflow that really collects one record per row.
 */
test("observe page structure, highlight matched rows and apply the proposal", async ({
  playwright,
}, testInfo) => {
  test.setTimeout(90_000);
  const site = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const rows = [1, 2, 3]
      .map(
        (at) =>
          `<article class="product"><h2 class="title">Item ${at}</h2><a class="link" href="/item/${at}">Open ${at}</a></article>`,
      )
      .join("");
    // The next-page control exists on the first page only, so the loop stops there.
    const next = url.pathname === "/" ? '<a class="next" href="/page/2">Next</a>' : "";
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(
      `<!doctype html><title>Observe fixture</title><main class="catalog"><section class="results">${rows}</section></main><nav class="pager">${next}</nav>`,
    );
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

    await ui.getByRole("button", { name: "识别当前页面", exact: true }).click();
    const lists = ui.getByRole("combobox", { name: "列表区域" });
    await expect(lists).toBeEnabled();
    // The proposed region addresses the repeated rows, one record each.
    await expect(lists).toContainText("article.product");
    await expect(ui.locator(".suggest-fields .workflow-check")).toHaveCount(2);

    // Live highlight: the rows carry the marker and the injected outline style.
    await expect
      .poll(() => browser.locator("[data-clawler-highlight]").count())
      .toBe(3);
    await expect
      .poll(async () =>
        browser.evaluate(
          () =>
            getComputedStyle(document.querySelector("[data-clawler-highlight]") as Element)
              .outlineStyle,
        ),
      )
      .toBe("solid");
    await ui.screenshot({ path: testInfo.outputPath("observe-candidates-zh.png") });

    await ui.getByRole("button", { name: "应用所选字段", exact: true }).click();
    await expect(ui.getByRole("textbox", { name: "列表项选择器" })).toHaveValue(
      /article\.product$/u,
    );
    await ui.getByRole("button", { name: "发布并运行", exact: true }).click();
    await expect
      .poll(async () => (await ui.evaluate(() => window.clawler?.getWorkspace()))?.runs[0]?.status)
      .toBe("succeeded");
    const workspace = await ui.evaluate(() => window.clawler?.getWorkspace());
    const run = workspace?.runs[0];
    expect(run?.result?.records?.map((row) => row.title)).toEqual(["Item 1", "Item 2", "Item 3"]);
    expect(run?.result?.records?.map((row) => row.link)).toEqual([
      `${targetUrl}item/1`,
      `${targetUrl}item/2`,
      `${targetUrl}item/3`,
    ]);
    expect(run?.result?.collection).toMatchObject({
      pages: 2,
      stopReason: "next-unavailable",
    });
    await ui.screenshot({ path: testInfo.outputPath("observe-applied-zh.png") });
  } finally {
    await application.close();
    site.closeAllConnections();
    await new Promise<void>((done) => site.close(() => done()));
  }
});
