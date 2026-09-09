import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

test("live Quotes site: record pagination, save recipe, collect two real pages", async ({
  playwright,
}, testInfo) => {
  test.skip(process.env.CLAWLER_LIVE_TEST !== "1", "Explicit external-site experiment");
  test.setTimeout(120_000);
  const dataDirectory = testInfo.outputPath("user-data");
  await mkdir(dataDirectory, { recursive: true });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CLAWLER_GATEWAY_TOKEN;
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
    await ui.getByRole("button", { name: "打开 Quotes 实验网站" }).click();
    await expect
      .poll(
        () =>
          application
            .context()
            .pages()
            .some((page) => page.url() === "https://quotes.toscrape.com/"),
        { timeout: 35_000 },
      )
      .toBe(true);
    const browser = application
      .context()
      .pages()
      .find((page) => page.url() === "https://quotes.toscrape.com/");
    if (!browser) throw new Error("Missing browser");
    await expect(browser.locator(".quote")).toHaveCount(10);
    await ui.getByRole("button", { name: "开始录制", exact: true }).click();
    await expect(ui.getByRole("button", { name: "结束并整理步骤" })).toBeEnabled();
    await browser.locator(".next a").click();
    await expect(browser).toHaveURL("https://quotes.toscrape.com/page/2/");
    await ui.getByRole("button", { name: "结束并整理步骤" }).click();
    await expect(ui.locator(".recorded-actions li")).toHaveCount(1);
    await ui.getByRole("button", { name: "将最后一次点击设为下一页循环" }).click();
    await ui.getByRole("button", { name: "保存并试跑", exact: true }).click();
    await expect
      .poll(
        async () => (await ui.evaluate(() => window.clawler?.getWorkspace()))?.runs[0]?.status,
        { timeout: 60_000 },
      )
      .toBe("succeeded");
    const workspace = await ui.evaluate(() => window.clawler?.getWorkspace());
    const run = workspace?.runs[0];
    expect(run?.result?.records).toHaveLength(20);
    expect(run?.result?.records?.every((row) => Boolean(row.quote && row.author))).toBe(true);
    expect(run?.result?.collection).toEqual({
      pages: 2,
      stopReason: "page-limit",
      truncated: true,
    });
    await writeFile(testInfo.outputPath("live-result.json"), JSON.stringify(run, null, 2));
    await ui.screenshot({ path: testInfo.outputPath("live-results.png") });
    await ui.locator(".instance-tab").nth(1).click();
    await ui.screenshot({ path: testInfo.outputPath("live-workflow.png") });
    await ui.locator(".instance-tab").first().click();
    await expect(ui.locator(".browser-slot")).toBeVisible();
    await browser.screenshot({ path: testInfo.outputPath("live-browser.png") });
    await writeFile(
      testInfo.outputPath("live-workflow.json"),
      JSON.stringify(workspace?.instances[0]?.workflow, null, 2),
    );
  } finally {
    await application.close();
  }
});
