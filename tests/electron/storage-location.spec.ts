import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { type ElectronApplication, expect, test } from "@playwright/test";
import { readRuntime } from "./runtime.test-support";

async function ready(application: ElectronApplication) {
  await expect
    .poll(() => application.windows().some((page) => page.url().startsWith("clawler-app://ui/")))
    .toBe(true);
  const page = application.windows().find((entry) => entry.url().startsWith("clawler-app://ui/"));
  if (!page) throw new Error("Missing UI");
  return page;
}

test("custom directory migrates workspace, SQLite and browser cookies with reversible scheduling", async ({
  playwright,
}, testInfo) => {
  const root = testInfo.outputPath("location");
  await mkdir(root, { recursive: true });
  const source = join(root, "original");
  const target = join(root, "自定义 数据目录");
  const configuration = join(root, "launcher");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CLAWLER_DATA_DIR;
  delete env.CLAWLER_GATEWAY_TOKEN;
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  await new Promise<void>((done) => reservation.close(() => done()));
  env.CLAWLER_GATEWAY_PORT = String(address.port);
  env.CLAWLER_GATEWAY_TOKEN = "storage-location-test-token-32-characters";
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${address.port}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${env.CLAWLER_GATEWAY_TOKEN}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
  env.CLAWLER_TEST = "1";
  env.CLAWLER_DEFAULT_DATA_DIR = source;
  env.CLAWLER_CONFIG_DIR = configuration;
  const launch = () => playwright._electron.launch({ args: [resolve("apps/desktop")], env });
  let application = await launch();
  try {
    let page = await ready(application);
    const initial = await page.evaluate(() => window.clawler?.getWorkspace());
    const instance = initial?.instances[0];
    if (!instance) throw new Error("Missing instance");
    await page.evaluate((id) => window.clawler?.startRun(id), instance.id);
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.clawler?.getWorkspace())?.runs[0]?.status),
      )
      .toBe("succeeded");
    await application.evaluate(async ({ session }, profileId) => {
      const profile = session.fromPartition(`persist:profile-${profileId}`);
      await profile.cookies.set({
        url: "https://example.com",
        name: "location-test",
        value: "preserved",
        expirationDate: Math.floor(Date.now() / 1000) + 86400,
      });
      await profile.cookies.flushStore();
    }, instance.profileId);
    const { job } = await (
      await api("/v1/jobs", {
        method: "POST",
        headers: { "Idempotency-Key": "location-first" },
        body: JSON.stringify({ instanceId: instance.id }),
      })
    ).json();
    await expect
      .poll(async () => (await (await api(`/v1/jobs/${job.id}`)).json()).job.status)
      .toBe("succeeded");
    const originalOutput = await (await api(`/v1/jobs/${job.id}/result`)).text();
    await page.locator(".workspace-nav .nav-item").nth(3).click();
    await expect(page.locator("#storage-current")).toHaveValue(source);
    await expect(page.locator("aside")).toHaveCount(0);
    await page.locator("#storage-destination").fill(join(source, "child"));
    await page.getByRole("button", { name: "保存目录变更", exact: true }).click();
    await expect(page.locator(".storage-error")).toBeVisible();
    await page.locator("#storage-destination").fill(target);
    await page.locator("#storage-destination").focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "选择文件夹", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "保存目录变更", exact: true }).click();
    await expect(page.locator(".storage-pending code")).toHaveText(target);
    await page.getByRole("button", { name: "取消目录变更", exact: true }).click();
    await expect(page.locator(".storage-pending")).toHaveCount(0);
    await page.locator("#storage-destination").fill(target);
    await page.getByRole("button", { name: "保存目录变更", exact: true }).click();
    await expect(page.locator(".storage-pending")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("storage-zh.png"), fullPage: true });
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(1080, 760),
    );
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.screenshot({ path: testInfo.outputPath("storage-compact-zh.png"), fullPage: true });
    await page.getByRole("button", { name: "取消目录变更", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath("storage-compact-actions-zh.png"),
      fullPage: true,
    });
    await page.getByRole("combobox", { name: "显示语言" }).selectOption("en-US");
    await expect(
      page.getByRole("heading", { name: "Storage location", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("storage-en.png"), fullPage: true });
    await application.evaluate(({ app }) => app.quit());
    await application.close();
    application = await launch();
    page = await ready(application);
    await page.locator(".workspace-nav .nav-item").nth(3).click();
    await expect(page.locator("#storage-current")).toHaveValue(target);
    await expect(page.locator(".storage-pending")).toHaveCount(0);
    const restored = await page.evaluate(() => window.clawler?.getWorkspace());
    expect(restored?.instances[0]?.id).toBe(instance.id);
    expect(restored?.runs[0]?.status).toBe("succeeded");
    expect(await page.locator("html").getAttribute("lang")).toBe("en-US");
    expect(readRuntime(target, "SELECT id FROM runs")).toEqual(
      readRuntime(source, "SELECT id FROM runs"),
    );
    const cookies = await application.evaluate(
      async ({ app, session }, profileId) => ({
        root: app.getPath("sessionData"),
        cookies: await session
          .fromPartition(`persist:profile-${profileId}`)
          .cookies.get({ name: "location-test" }),
      }),
      instance.profileId,
    );
    expect(cookies.root).toBe(target);
    expect(cookies.cookies[0]?.value).toBe("preserved");
    expect(await (await api(`/v1/jobs/${job.id}/result`)).text()).toBe(originalOutput);
    const replay = await api("/v1/jobs", {
      method: "POST",
      headers: { "Idempotency-Key": "location-first" },
      body: JSON.stringify({ instanceId: instance.id }),
    });
    expect(replay.status).toBe(200);
    expect((await replay.json()).job.id).toBe(job.id);
    const archivePath = join("runtime", "instances", instance.id, "jobs", job.id, "result.json");
    expect(await readFile(join(target, archivePath), "utf8")).toBe(
      await readFile(join(source, archivePath), "utf8"),
    );
    expect(JSON.parse(await readFile(join(configuration, "launcher.json"), "utf8")).directory).toBe(
      target,
    );
  } finally {
    await application.close();
  }
});
