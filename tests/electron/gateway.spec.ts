import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { type ElectronApplication, expect, test } from "@playwright/test";
import { readRuntime } from "./runtime.test-support";

async function ready(application: ElectronApplication) {
  await expect
    .poll(() => application.windows().some((page) => page.url().startsWith("clawler-app://ui/")))
    .toBe(true);
}

test("gateway drives real Chromium, archives results and recovers waiting work on restart", async ({
  playwright,
}, testInfo) => {
  const dataDirectory = testInfo.outputPath("gateway-user-data");
  await mkdir(dataDirectory, { recursive: true });
  const portReservation = createServer();
  await new Promise<void>((done) => portReservation.listen(0, "127.0.0.1", done));
  const address = portReservation.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  await new Promise<void>((done) => portReservation.close(() => done()));
  const slowSite = createServer(() => {});
  await new Promise<void>((done) => slowSite.listen(0, "127.0.0.1", done));
  const slowAddress = slowSite.address();
  if (!slowAddress || typeof slowAddress === "string") throw new Error("Missing site port");
  const token = "electron-test-token-with-thirty-two-characters";
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  env.CLAWLER_TEST = "1";
  env.CLAWLER_DATA_DIR = dataDirectory;
  env.CLAWLER_GATEWAY_TOKEN = token;
  env.CLAWLER_GATEWAY_PORT = String(address.port);
  const launch = () => playwright._electron.launch({ args: [resolve("apps/desktop")], env });
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${address.port}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
  let application = await launch();
  try {
    await ready(application);
    expect((await request("/v1/health")).status).toBe(200);
    const { instances } = await (await request("/v1/instances")).json();
    const instanceId = instances[0].id;
    const submit = (key: string, targetUrl?: string) =>
      request("/v1/jobs", {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: JSON.stringify({ instanceId, targetUrl }),
      });
    const accepted = await submit("first");
    expect(accepted.status).toBe(202);
    const { job } = await accepted.json();
    const status = async (id: string) =>
      (await (await request(`/v1/jobs/${id}`)).json()).job.status;
    await expect.poll(() => status(job.id)).toBe("succeeded");
    const output = await (await request(`/v1/jobs/${job.id}/result`)).json();
    expect(output.title).toBe("Clawler Playground");
    expect(output.links).toHaveLength(3);
    const artifactDirectory = join(
      dataDirectory,
      "runtime",
      "instances",
      instanceId,
      "jobs",
      job.id,
    );
    expect(JSON.parse(await readFile(join(artifactDirectory, "result.json"), "utf8"))).toEqual(
      output,
    );
    expect(await (await request(`/v1/jobs/${job.id}/result?format=csv`)).text()).toBe(
      await readFile(join(artifactDirectory, "result.csv"), "utf8"),
    );
    const artifacts = readRuntime(
      dataDirectory,
      "SELECT path,bytes,sha256 FROM artifacts WHERE jobId=?",
      job.id,
    );
    expect(artifacts).toHaveLength(4);
    for (const artifact of artifacts) {
      const content = await readFile(join(dataDirectory, "runtime", String(artifact.path)));
      expect(artifact.bytes).toBe(content.byteLength);
      expect(artifact.sha256).toBe(createHash("sha256").update(content).digest("hex"));
    }
    const slow = (await (await submit("slow", `http://127.0.0.1:${slowAddress.port}/slow`)).json())
      .job;
    await expect.poll(() => status(slow.id)).toBe("running");
    const waiting = (await (await submit("waiting")).json()).job;
    expect(waiting.status).toBe("queued");
    // Exercise the application's graceful close handler (Playwright close can force process exit).
    await application.evaluate(({ app }) => {
      app.quit();
    });
    await expect
      .poll(async () => {
        return readRuntime(dataDirectory, "SELECT status FROM gateway_jobs WHERE id=?", slow.id)[0]
          ?.status;
      })
      .toBe("cancelled");
    await application.close();
    application = await launch();
    await ready(application);
    await expect.poll(() => status(waiting.id)).toBe("succeeded");
    expect(await status(slow.id)).toBe("cancelled");
    const replay = await submit("first");
    expect(replay.status).toBe(200);
    expect((await replay.json()).job.id).toBe(job.id);
    expect((await (await request("/v1/jobs")).json()).total).toBe(3);
  } finally {
    await application.close();
    slowSite.closeAllConnections();
    await new Promise<void>((done) => slowSite.close(() => done()));
  }
});
