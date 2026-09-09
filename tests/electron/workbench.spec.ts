import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { type ElectronApplication, expect, test } from "@playwright/test";

async function workbenchPage(application: ElectronApplication) {
  await expect
    .poll(() => application.windows().some((page) => page.url().startsWith("clawler-app://ui/")))
    .toBe(true);
  const page = application.windows().find((entry) => entry.url().startsWith("clawler-app://ui/"));
  if (!page) throw new Error("No application UI page");
  return page;
}

test("real browser, script execution, profile isolation, persistence and localization", async ({
  playwright,
}, testInfo) => {
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
  const launch = () => playwright._electron.launch({ args: [resolve("apps/desktop")], env });
  let application = await launch();
  try {
    let page = await workbenchPage(application);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.locator(".window-controls button")).toHaveCount(3);
    expect(
      await page.evaluate(() => getComputedStyle(document.documentElement).scrollbarWidth),
    ).toBe("none");
    await expect(page.locator(".instances-page")).toBeVisible();
    await expect(page.locator(".instance-row")).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath("instances-zh.png") });
    await page.locator(".instance-main").first().click();
    await expect(page.locator(".instance-detail")).toBeVisible();
    await page.locator(".instance-detail-actions .button--primary").click();
    await expect
      .poll(async () =>
        page.evaluate(async () => (await window.clawler?.getWorkspace())?.runs[0]?.status),
      )
      .toBe("succeeded");
    const initial = await page.evaluate(() => window.clawler?.getWorkspace());
    expect(initial?.runs[0]?.result?.title).toBe("Clawler Playground");
    expect(initial?.runs[0]?.result?.links).toHaveLength(3);
    expect(initial?.runs[0]?.result?.url).toBe("clawler-demo://catalog/");
    await page.screenshot({ path: testInfo.outputPath("workbench-zh.png") });

    const remoteIsolation = await application.evaluate(async ({ webContents }) => {
      const contents = webContents
        .getAllWebContents()
        .find((entry) => entry.getURL() === "clawler-demo://catalog/");
      if (!contents) throw new Error("No embedded browser");
      return {
        globals: await contents.executeJavaScript(
          "({node: typeof process, bridge: typeof window.clawler})",
        ),
        scrollbarWidth: await contents.executeJavaScript(
          "getComputedStyle(document.documentElement).scrollbarWidth",
        ),
      };
    });
    expect(remoteIsolation.globals).toEqual({ node: "undefined", bridge: "undefined" });
    expect(remoteIsolation.scrollbarWidth).toBe("none");

    await page.locator(".instance-tab").nth(1).click();
    await page.getByRole("button", { name: "编辑草稿", exact: true }).click();
    const draftSource =
      "// A saved draft must never replace the published example\nthrow new Error('not published');";
    await page.getByRole("textbox", { name: "脚本源码" }).fill(draftSource);
    await page.getByRole("button", { name: "保存草稿", exact: true }).click();
    await expect
      .poll(async () =>
        page.evaluate(async () => (await window.clawler?.getWorkspace())?.draft.source),
      )
      .toBe(draftSource);
    await page.locator(".instance-detail-actions .button--primary").click();
    await expect
      .poll(async () =>
        page.evaluate(
          async () =>
            (await window.clawler?.getWorkspace())?.runs.filter((run) => run.status === "succeeded")
              .length,
        ),
      )
      .toBe(2);

    await page.locator(".instance-detail-header > .button").first().click();
    await page.locator(".instances-heading .button--primary").click();
    await page.locator("#instance-name").fill("Catalog monitor");
    await page.locator(".instance-create-bar .button--primary").click();
    await expect(page.locator(".instance-detail-title h1")).toHaveText("Catalog monitor");
    expect((await page.evaluate(() => window.clawler?.getWorkspace()))?.instances).toHaveLength(2);
    await page.locator(".instance-tab").nth(2).click();
    await page.locator("#config-target-url").fill("https://example.com");
    await page.locator(".instance-config-actions .button--primary").click();
    await expect
      .poll(async () => {
        const snapshot = await page.evaluate(() => window.clawler?.getWorkspace());
        return snapshot?.instances.find((instance) => instance.name === "Catalog monitor")
          ?.targetUrl;
      })
      .toBe("https://example.com/");

    await page.locator(".workspace-nav .nav-item").nth(1).click();
    await page.getByRole("textbox", { name: "环境名称" }).fill("Profile B");
    await page.getByRole("button", { name: "创建环境", exact: true }).click();
    const newProfile = page
      .locator(".profile-card")
      .filter({ has: page.getByRole("heading", { name: "Profile B", exact: true }) });
    await newProfile.getByRole("button", { name: "切换到此环境" }).click();
    const profiles = await page.evaluate(() => window.clawler?.getWorkspace());
    expect(profiles?.profiles).toHaveLength(2);
    const originalId = initial?.selectedProfileId;
    const secondId = profiles?.selectedProfileId;
    if (!originalId || !secondId) throw new Error("Missing profile identifiers");
    expect(originalId).not.toBe(secondId);
    const isolated = await application.evaluate(
      async ({ session }, ids) => {
        const original = session.fromPartition(`persist:profile-${ids.originalId}`);
        const second = session.fromPartition(`persist:profile-${ids.secondId}`);
        await original.cookies.set({
          url: "https://example.com",
          name: "profile-test",
          value: "only-profile-a",
        });
        return {
          original: await original.cookies.get({ name: "profile-test" }),
          second: await second.cookies.get({ name: "profile-test" }),
        };
      },
      { originalId, secondId },
    );
    expect(isolated.original).toHaveLength(1);
    expect(isolated.second).toHaveLength(0);

    await page.locator(".workspace-nav .nav-item").nth(3).click();
    await page.getByRole("combobox", { name: "显示语言" }).selectOption("en-US");
    await expect(page.getByRole("heading", { name: "Preferences", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Instances", exact: true })).toBeVisible();
    expect(await page.locator("html").getAttribute("lang")).toBe("en-US");
    await page.screenshot({ path: testInfo.outputPath("workbench-en.png") });
    expect(errors).toEqual([]);

    await application.close();
    application = await launch();
    page = await workbenchPage(application);
    await expect(page.getByRole("button", { name: "Instances", exact: true })).toBeVisible();
    const restored = await page.evaluate(() => window.clawler?.getWorkspace());
    expect(restored?.draft.source).toBe(draftSource);
    expect(restored?.profiles).toHaveLength(2);
    expect(restored?.instances).toHaveLength(2);
    expect(restored?.selectedProfileId).toBe(secondId);
    expect(restored?.runs[0]?.status).toBe("succeeded");
  } finally {
    await application.close();
  }
});
