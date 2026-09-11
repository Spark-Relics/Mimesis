import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { readRuntime } from "./runtime.test-support";

test("closing the desktop without a gateway persists the active run cancellation", async ({
  playwright,
}, testInfo) => {
  const root = testInfo.outputPath("desktop-storage");
  await mkdir(root, { recursive: true });
  const site = createServer(() => {});
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const address = site.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CLAWLER_GATEWAY_TOKEN;
  env.CLAWLER_TEST = "1";
  env.CLAWLER_DATA_DIR = root;
  const application = await playwright._electron.launch({ args: [resolve("apps/desktop")], env });
  try {
    await expect
      .poll(() => application.windows().some((page) => page.url().startsWith("clawler-app://ui/")))
      .toBe(true);
    const page = application.windows().find((entry) => entry.url().startsWith("clawler-app://ui/"));
    if (!page) throw new Error("Missing UI");
    const runId = await page.evaluate(async (url) => {
      const api = window.clawler;
      const instance = (await api?.getWorkspace())?.instances[0];
      if (!api || !instance) throw new Error("Missing instance");
      await api.updateInstance(instance.id, {
        name: instance.name,
        profileId: instance.profileId,
        enabled: true,
        targetUrl: url,
      });
      return (await api.startRun(instance.id)).id;
    }, `http://127.0.0.1:${address.port}/slow`);
    await expect
      .poll(() => readRuntime(root, "SELECT status FROM runs WHERE id=?", runId)[0]?.status)
      .toBe("running");
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await expect
      .poll(() => readRuntime(root, "SELECT status FROM runs WHERE id=?", runId)[0]?.status)
      .toBe("cancelled");
    expect(
      readRuntime(root, "SELECT finishedAt FROM runs WHERE id=?", runId)[0]?.finishedAt,
    ).toBeTruthy();
  } finally {
    await application.close();
    site.closeAllConnections();
    await new Promise<void>((done) => site.close(() => done()));
  }
});
