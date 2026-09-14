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

test("publish freezes content, blocks unpublished runs and keeps already accepted jobs on their version", async ({
  playwright,
}, testInfo) => {
  test.setTimeout(90_000);
  // The served value depends on the requested address, so a run proves which snapshot it used.
  const site = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const field = url.searchParams.get("field") ?? "text";
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(
      `<!doctype html><title>Version fixture</title><input id="search" name="keyword"><article class="row"><span class="quote">${field}-one</span></article>`,
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
  env.CLAWLER_GATEWAY_TOKEN = "versions-test-token-at-least-thirty-two-characters";
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
      before: [{ kind: "fill", selector: "#search", value: "{{keyword}}" }],
      extract: {
        items: ".row",
        fields: [{ name: "value", selector: ".quote", attribute: "text", required: true }],
      },
      pagination: null,
      waitTimeoutMs: 3000,
      maxRecords: 10,
    };
    await ui.evaluate(
      ({ id, recipe, url, profileId }) =>
        window.clawler?.saveWorkflow(id, recipe, {
          name: "Versioned catalog",
          targetUrl: url,
          profileId,
          enabled: true,
        }),
      { id: instance.id, recipe: workflow, url: targetUrl, profileId: instance.profileId },
    );

    // Unpublished content must never execute.
    await expect(ui.evaluate((id) => window.clawler?.startRun(id), instance.id)).rejects.toThrow(
      "NO_PUBLISHED_VERSION",
    );

    const first = await ui.evaluate((id) => window.clawler?.publishWorkflow(id), instance.id);
    if (!first) throw new Error("Missing published version");
    expect(first.version).toBe(1);
    expect(first.targetUrl).toBe(targetUrl);
    expect(first.digest).toHaveLength(64);

    // Republishing unchanged content reuses the snapshot instead of duplicating history.
    const again = await ui.evaluate((id) => window.clawler?.publishWorkflow(id), instance.id);
    expect(again?.id).toBe(first.id);

    const run = await ui.evaluate(({ id }) => window.clawler?.startRun(id, { keyword: "alpha" }), {
      id: instance.id,
    });
    await expect
      .poll(() => ui.evaluate(async () => (await window.clawler?.getWorkspace())?.runs[0]?.status))
      .toBe("succeeded");
    const bound = await ui.evaluate(() => window.clawler?.getWorkspace());
    expect(bound?.runs[0]?.workflowVersionId).toBe(first.id);
    expect(bound?.runs[0]?.result?.records?.[0]?.value).toBe("text-one");
    expect(bound?.versions).toHaveLength(1);
    expect(bound?.instances[0]?.publishedVersionId).toBe(first.id);
    expect(run?.workflowVersionId).toBe(first.id);

    // Editing the draft must not change what runs until it is published again.
    const changed: CollectionWorkflow = {
      ...workflow,
      extract: {
        items: ".row",
        fields: [{ name: "value", selector: ".quote", attribute: "text", required: true }],
      },
      maxRecords: 25,
    };
    await ui.evaluate(
      ({ id, recipe, url, profileId }) =>
        window.clawler?.saveWorkflow(id, recipe, {
          name: "Versioned catalog",
          targetUrl: `${url}?field=changed`,
          profileId,
          enabled: true,
        }),
      { id: instance.id, recipe: changed, url: targetUrl, profileId: instance.profileId },
    );
    const drafted = await ui.evaluate(() => window.clawler?.getWorkspace());
    expect(drafted?.versions).toHaveLength(1);
    expect(drafted?.instances[0]?.publishedVersionId).toBe(first.id);
    // The published snapshot keeps its own address, so a run still targets the frozen content.
    await ui.evaluate((id) => window.clawler?.startRun(id, { keyword: "beta" }), instance.id);
    await expect
      .poll(() => ui.evaluate(async () => (await window.clawler?.getWorkspace())?.runs[0]?.status))
      .toBe("succeeded");
    const frozen = await ui.evaluate(() => window.clawler?.getWorkspace());
    expect(frozen?.runs[0]?.workflowVersionId).toBe(first.id);
    // The draft address would have served "changed-one"; the frozen version still serves its own.
    expect(frozen?.runs[0]?.result?.records?.[0]?.value).toBe("text-one");

    // Publishing the edited draft adds a version and rebinds execution.
    const second = await ui.evaluate(
      (id) => window.clawler?.publishWorkflow(id, "second"),
      instance.id,
    );
    expect(second?.version).toBe(2);
    expect(second?.id).not.toBe(first.id);
    expect(second?.note).toBe("second");
    expect(second?.digest).not.toBe(first.digest);
    // Publishing rebinds new runs to the new snapshot and its own address.
    await ui.evaluate((id) => window.clawler?.startRun(id, { keyword: "delta" }), instance.id);
    await expect
      .poll(() => ui.evaluate(async () => (await window.clawler?.getWorkspace())?.runs[0]?.status))
      .toBe("succeeded");
    const republished = await ui.evaluate(() => window.clawler?.getWorkspace());
    expect(republished?.runs[0]?.workflowVersionId).toBe(second?.id);
    expect(republished?.runs[0]?.result?.records?.[0]?.value).toBe("changed-one");

    // Rollback changes what new runs use without touching the stored draft or the published set.
    const rolled = await ui.evaluate(
      ({ id, versionId }) => window.clawler?.rollbackWorkflow(id, versionId),
      { id: instance.id, versionId: first.id },
    );
    expect(rolled?.publishedVersionId).toBe(first.id);
    const afterRollback = await ui.evaluate(() => window.clawler?.getWorkspace());
    expect(afterRollback?.versions).toHaveLength(2);
    expect(afterRollback?.instances[0]?.workflow?.maxRecords).toBe(25);

    await ui.evaluate((id) => window.clawler?.startRun(id, { keyword: "gamma" }), instance.id);
    await expect
      .poll(() => ui.evaluate(async () => (await window.clawler?.getWorkspace())?.runs[0]?.status))
      .toBe("succeeded");
    const rolledRun = await ui.evaluate(() => window.clawler?.getWorkspace());
    expect(rolledRun?.runs[0]?.workflowVersionId).toBe(first.id);
    expect(rolledRun?.runs[0]?.result?.records?.[0]?.value).toBe("text-one");

    // The gateway resolves the same binding, so API results follow the rollback too.
    const accepted = await fetch(`http://127.0.0.1:${endpoint.port}/v1/jobs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CLAWLER_GATEWAY_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ instanceId: instance.id, parameters: { keyword: "delta" } }),
    });
    expect(accepted.status).toBe(202);
    const { job } = await accepted.json();
    expect(job.execution.binding.versionId).toBe(first.id);
    await expect
      .poll(async () => {
        const response = await fetch(`http://127.0.0.1:${endpoint.port}/v1/jobs/${job.id}`, {
          headers: { Authorization: `Bearer ${env.CLAWLER_GATEWAY_TOKEN}` },
        });
        return (await response.json()).job.status;
      })
      .toBe("succeeded");

    // Bridge calls above bypass the renderer controller, so reload to read the stored history.
    await ui.reload();
    await expect(ui.locator(".instance-main").first()).toBeVisible();
    await ui.locator(".instance-main").first().click();
    await ui.getByRole("button", { name: "版本" }).click();
    await expect(ui.locator(".version-row")).toHaveCount(2);
    await expect(ui.locator(".version-row.is-active strong")).toHaveText("v1");
    await ui.screenshot({ path: testInfo.outputPath("versions-zh.png") });

    await ui.locator(".workspace-nav .nav-item").nth(3).click();
    await ui.getByRole("combobox", { name: "显示语言" }).selectOption("en-US");
    await expect(ui.getByRole("heading", { name: "Preferences", exact: true })).toBeVisible();
    await ui.locator(".workspace-nav .nav-item").nth(0).click();
    await ui.locator(".instance-main").first().click();
    await ui.locator(".instance-tab").nth(3).click();
    await expect(ui.getByRole("heading", { name: "Published versions" })).toBeVisible();
    await expect(ui.locator(".version-row.is-active")).toContainText("In use");
    await ui.screenshot({ path: testInfo.outputPath("versions-en.png") });

    // Switching from the list rebinds execution to the selected snapshot.
    await ui.getByRole("button", { name: "Switch to v2" }).click();
    await expect(ui.locator(".version-row.is-active strong")).toHaveText("v2");
    const switched = await ui.evaluate(() => window.clawler?.getWorkspace());
    expect(switched?.instances[0]?.publishedVersionId).toBe(second?.id);
    await ui.evaluate((id) => window.clawler?.startRun(id, { keyword: "epsilon" }), instance.id);
    await expect
      .poll(() => ui.evaluate(async () => (await window.clawler?.getWorkspace())?.runs[0]?.status))
      .toBe("succeeded");
    const switchedRun = await ui.evaluate(() => window.clawler?.getWorkspace());
    expect(switchedRun?.runs[0]?.workflowVersionId).toBe(second?.id);
    expect(switchedRun?.runs[0]?.result?.records?.[0]?.value).toBe("changed-one");
  } finally {
    await application.close();
    await new Promise<void>((done) => site.close(() => done()));
  }
});
