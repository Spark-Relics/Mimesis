import { mkdir, readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { type ElectronApplication, expect, test } from "@playwright/test";

async function ready(application: ElectronApplication) {
  const process = application.process();
  process.stderr?.on("data", (chunk: Buffer) => console.error("[electron]", chunk.toString()));
  await expect
    .poll(() => application.windows().some((page) => page.url().startsWith("clawler-app://ui/")))
    .toBe(true);
  const page = application.windows().find((entry) => entry.url().startsWith("clawler-app://ui/"));
  if (!page) throw new Error("Missing UI");
  return page;
}

test("backup captures the workspace on next launch and restores it after corruption", async ({
  playwright,
}, testInfo) => {
  const root = testInfo.outputPath("backup");
  await mkdir(root, { recursive: true });
  const live = join(root, "live");
  const backup = join(root, "完整 备份");
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
  env.CLAWLER_GATEWAY_TOKEN = "backup-restore-test-token-32-characters";
  env.CLAWLER_TEST = "1";
  env.CLAWLER_DEFAULT_DATA_DIR = live;
  env.CLAWLER_CONFIG_DIR = configuration;
  const launch = () => playwright._electron.launch({ args: [resolve("apps/desktop")], env });

  // First session: produce real data, then schedule a backup from the UI.
  let application = await launch();
  try {
    const page = await ready(application);
    const initial = await page.evaluate(() => window.clawler?.getWorkspace());
    const instance = initial?.instances[0];
    if (!instance) throw new Error("Missing instance");
    await page.evaluate((id) => window.clawler?.startRun(id), instance.id);
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.clawler?.getWorkspace())?.runs[0]?.status),
      )
      .toBe("succeeded");
    await page.locator(".workspace-nav .nav-item").nth(3).click();
    await expect(page.locator("#storage-current")).toHaveValue(live);
    await page.locator("#storage-backup-target").fill(backup);
    await page.getByRole("button", { name: "安排备份", exact: true }).click();
    await expect(page.locator(".storage-backup .storage-pending code")).toHaveText(backup);
    await page.screenshot({ path: testInfo.outputPath("backup-pending-zh.png"), fullPage: true });
    // Cancelling and re-scheduling keeps exactly one plan.
    await page.getByRole("button", { name: "取消备份计划", exact: true }).click();
    await expect(page.locator(".storage-backup .storage-pending")).toHaveCount(0);
    await page.locator("#storage-backup-target").fill(backup);
    await page.getByRole("button", { name: "安排备份", exact: true }).click();
    await expect(page.locator(".storage-backup .storage-pending code")).toHaveText(backup);
  } finally {
    await application.close();
  }

  // Second launch executes the backup; the pending plan clears afterwards.
  application = await launch();
  try {
    const page = await ready(application);
    await page.locator(".workspace-nav .nav-item").nth(3).click();
    await expect(page.locator("#storage-current")).toHaveValue(live);
    await expect(page.locator(".storage-backup .storage-pending")).toHaveCount(0);
    const marker = JSON.parse(await readFile(join(backup, ".mimesis-backup.json"), "utf8"));
    expect(marker.complete).toBe(true);
    expect(marker.plan.kind).toBe("backup");
    expect(marker.files.length).toBeGreaterThan(0);
    // Live root still works and is untouched.
    const workspace = await page.evaluate(() => window.clawler?.getWorkspace());
    expect(workspace?.runs[0]?.status).toBe("succeeded");

    // Corrupt the live workspace file, then schedule a restore from the backup.
    const databaseFile = join(live, "runtime", "runtime.sqlite");
    const before = await readFile(databaseFile);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(databaseFile, Buffer.concat([before, Buffer.from("corruption")]));
    await page.locator("#storage-backup-restore").fill(backup);
    await page.getByRole("button", { name: "安排恢复", exact: true }).click();
    await expect(page.locator(".storage-backup .storage-pending")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("restore-pending-zh.png"), fullPage: true });
  } finally {
    await application.close();
  }

  // Third launch restores into a fresh directory and switches to it.
  application = await launch();
  try {
    const page = await ready(application);
    await page.locator(".workspace-nav .nav-item").nth(3).click();
    await expect(page.locator(".storage-backup .storage-pending")).toHaveCount(0);
    const restoredRoot = (await readdir(root)).find((name) => name.startsWith("mimesis-restored-"));
    if (!restoredRoot) throw new Error("Missing restored directory");
    await expect(page.locator("#storage-current")).toHaveText("");
    const current = await page.locator("#storage-current").inputValue();
    expect(current).toBe(join(root, restoredRoot));
    // Restored data matches the backup, and the backup itself is intact.
    const workspace = await page.evaluate(() => window.clawler?.getWorkspace());
    expect(workspace?.runs[0]?.status).toBe("succeeded");
    const restoredDb = await readFile(join(root, restoredRoot, "runtime", "runtime.sqlite"));
    const backupDb = await readFile(join(backup, "runtime", "runtime.sqlite"));
    expect(restoredDb.equals(backupDb)).toBe(true);
    const launcher = JSON.parse(await readFile(join(configuration, "launcher.json"), "utf8"));
    expect(launcher.directory).toBe(join(root, restoredRoot));
    expect(launcher.pendingBackup).toBeNull();
  } finally {
    await application.close();
  }
});
