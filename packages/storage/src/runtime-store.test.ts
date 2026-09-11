import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gatewayJobSchema } from "@clawler/contracts";
import { build } from "vite";
import { beforeAll, expect, it } from "vitest";
import { completedRun, execution, submission } from "../../gateway/src/fixtures.test-support";
import { RuntimeStore } from "./runtime-store";
import type { StoredState } from "./state";

let workerFile: string;
beforeAll(async () => {
  const outDir = await mkdtemp(join(tmpdir(), "mimesis-storage-worker-"));
  await build({
    configFile: resolve("apps/desktop/vite.storage-worker.config.ts"),
    logLevel: "silent",
    build: { outDir, emptyOutDir: false },
  });
  workerFile = join(outDir, "index.cjs");
});
const profile = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Original",
  createdAt: "2026-09-11T00:00:00.000Z",
};
const state: StoredState = {
  schemaVersion: 3,
  profiles: [profile],
  selectedProfileId: profile.id,
  instances: [],
  runs: [],
};

it("migrates once, preserves source backups and serializes worker writes across restart", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "mimesis-worker-roundtrip-"));
  const source = join(root, "workspace.json");
  const legacy = JSON.stringify({
    ...state,
    schemaVersion: 2,
    draft: { source: "legacy source", updatedAt: profile.createdAt },
  });
  await writeFile(source, legacy);
  let store = await RuntimeStore.open(root, workerFile);
  context.onTestFinished(async () => {
    await store.close();
  });
  expect(await store.load()).toEqual(state);
  expect(await readFile(`${source}.pre-sqlite.backup.json`, "utf8")).toBe(legacy);
  expect(await readFile(source, "utf8")).toBe(legacy);
  await Promise.all([
    store.save({ ...state, profiles: [{ ...profile, name: "First" }] }),
    store.save({ ...state, profiles: [{ ...profile, name: "Last" }] }),
  ]);
  await store.close();
  await expect(store.load()).rejects.toThrow("STORAGE_FAILED");
  // Existing JSON must never become authoritative again after successful import.
  await writeFile(source, "broken old JSON");
  store = await RuntimeStore.open(root, workerFile);
  expect((await store.load())?.profiles[0]?.name).toBe("Last");
});

it("rejects a corrupt database despite a valid legacy workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "mimesis-worker-corrupt-"));
  await mkdir(join(root, "runtime"));
  await writeFile(join(root, "workspace.json"), JSON.stringify(state));
  const file = join(root, "runtime", "runtime.sqlite");
  await writeFile(file, "broken database");
  await expect(RuntimeStore.open(root, workerFile)).rejects.toThrow("STORAGE_FAILED");
  expect(await readFile(file, "utf8")).toBe("broken database");
});

it("imports legacy gateway jobs and only indexes archive files that exist", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "mimesis-gateway-import-"));
  const job = gatewayJobSchema.parse({
    id: crypto.randomUUID(),
    idempotencyKey: "imported",
    submission,
    execution,
    status: "succeeded",
    createdAt: profile.createdAt,
    startedAt: profile.createdAt,
    finishedAt: profile.createdAt,
    run: completedRun(),
    errorCode: null,
  });
  const path = `instances/${execution.instance.id}/jobs/${job.id}/job.json`;
  const archive = JSON.stringify(job);
  await mkdir(join(root, "runtime", "instances", execution.instance.id, "jobs", job.id), {
    recursive: true,
  });
  await writeFile(join(root, "runtime", path), archive);
  const legacy = JSON.stringify({ schemaVersion: 1, jobs: [job] });
  await writeFile(join(root, "runtime", "gateway.json"), legacy);
  const store = await RuntimeStore.open(root, workerFile);
  context.onTestFinished(async () => {
    await store.close();
  });
  expect((await store.loadGateway())?.jobs).toEqual([job]);
  expect(await readFile(join(root, "runtime", "gateway.json.pre-sqlite.backup.json"), "utf8")).toBe(
    legacy,
  );
  const db = new DatabaseSync(join(root, "runtime", "runtime.sqlite"), { readOnly: true });
  try {
    expect(db.prepare("SELECT * FROM artifacts").all()).toEqual([
      {
        jobId: job.id,
        path,
        bytes: Buffer.byteLength(archive),
        sha256: createHash("sha256").update(archive).digest("hex"),
      },
    ]);
  } finally {
    db.close();
  }
});

it("fails pending and subsequent requests when the worker exits unexpectedly", async () => {
  const root = await mkdtemp(join(tmpdir(), "mimesis-worker-exit-"));
  const fake = join(root, "exit.cjs");
  await writeFile(
    fake,
    `const { parentPort } = require('node:worker_threads');
parentPort.on('message', ({ id, command }) => {
  if (command.method === 'initialized') parentPort.postMessage({ id, ok: true, value: true });
  else process.exit(1);
});`,
  );
  const store = await RuntimeStore.open(root, fake);
  const responses = await Promise.allSettled([store.load(), store.loadGateway()]);
  expect(responses.every((response) => response.status === "rejected")).toBe(true);
  await expect(store.save(state)).rejects.toThrow("STORAGE_FAILED");
  await expect(store.close()).rejects.toThrow("STORAGE_FAILED");
});
