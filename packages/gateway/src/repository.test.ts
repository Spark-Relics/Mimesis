import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gatewayStateSchema } from "@clawler/contracts";
import { expect, it, vi } from "vitest";
import { RuntimeDatabase } from "../../storage/src/runtime-database";
import { completedRun, execution, submission } from "./fixtures.test-support";
import { GatewayQueue } from "./queue";
import { SqliteGatewayRepository } from "./repository";
import { cleanResult, serializeResult } from "./results";

it("archives runs and cleaned exports under their instance without changing raw data", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "mimesis-gateway-"));
  const db = new RuntimeDatabase(join(root, "runtime.sqlite"));
  context.onTestFinished(() => {
    db.dispatch({ method: "close" });
  });
  const repository = new SqliteGatewayRepository(root, {
    async loadGateway() {
      const value = db.dispatch({ method: "gateway.load" });
      if (value === null) return undefined;
      return gatewayStateSchema.parse(value);
    },
    async loadArtifacts() {
      return db.dispatch({ method: "artifacts.load" }) as never[];
    },
    async saveGateway(state, artifacts) {
      db.dispatch({ method: "gateway.save", state, artifacts });
    },
  });
  const raw = completedRun();
  const queue = await GatewayQueue.open(repository, {
    resolve: () => execution,
    execute: async () => raw,
  });
  const { job } = await queue.submit(submission);
  queue.start();
  await vi.waitFor(() => expect(queue.get(job.id).status).toBe("succeeded"));
  const folder = join(root, "instances", execution.instance.id, "jobs", job.id);
  const result = JSON.parse(await readFile(join(folder, "result.json"), "utf8"));
  expect(result.title).toBe("Catalog");
  expect(result.headings).toEqual(["One"]);
  expect(raw.result?.title).toBe(" Catalog ");
  expect(await readFile(join(folder, "result.csv"), "utf8")).toContain('"\'=SUM(1,2)"');
  const rows = (await readFile(join(folder, "result.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(rows.map((row) => row.kind)).toEqual(["document", "heading", "link"]);
  expect(JSON.parse(await readFile(join(folder, "job.json"), "utf8")).run.id).toBe(raw.id);
  await queue.close();
  expect((await repository.load())?.jobs[0]?.status).toBe("succeeded");
});

it("deletes evicted archives, artifact rows and orphaned runs together", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "mimesis-gateway-evict-"));
  const db = new RuntimeDatabase(join(root, "runtime.sqlite"));
  context.onTestFinished(() => {
    db.dispatch({ method: "close" });
  });
  const repository = new SqliteGatewayRepository(root, {
    async loadGateway() {
      const value = db.dispatch({ method: "gateway.load" });
      if (value === null) return undefined;
      return gatewayStateSchema.parse(value);
    },
    async saveGateway(state, artifacts, evicted = []) {
      db.dispatch({ method: "gateway.save", state, artifacts, evicted });
    },
    async loadArtifacts() {
      return db.dispatch({ method: "artifacts.load" }) as never[];
    },
  });
  const queue = await GatewayQueue.open(
    repository,
    {
      resolve: () => execution,
      execute: async () => completedRun(),
    },
    { maxPending: 10, maxStored: 1 },
  );
  queue.start();
  const first = await queue.submit(submission);
  await vi.waitFor(() => expect(queue.get(first.job.id).status).toBe("succeeded"));
  const second = await queue.submit(submission);
  await vi.waitFor(() => expect(queue.get(second.job.id).status).toBe("succeeded"));
  await queue.close();
  const instanceJobs = join(root, "instances", execution.instance.id, "jobs");
  expect(await readdir(instanceJobs)).toEqual([second.job.id]);
  const inspection = new DatabaseSync(join(root, "runtime.sqlite"), { readOnly: true });
  try {
    expect(inspection.prepare("SELECT COUNT(*) AS count FROM gateway_jobs").get()).toEqual({
      count: 1,
    });
    expect(inspection.prepare("SELECT COUNT(*) AS count FROM artifacts").get()).toEqual({
      count: 4,
    });
    expect(inspection.prepare("SELECT COUNT(*) AS count FROM runs").get()).toEqual({
      count: 1,
    });
  } finally {
    inspection.close();
  }
  expect((await repository.load())?.jobs.map((job) => job.id)).toEqual([second.job.id]);
});

it("handles quoted multilingual CSV, deduplication and disabled cleaning", () => {
  const input = {
    title: ' 中文,"标题"\nnext',
    url: "https://example.com/",
    headings: [" A ", "A"],
    links: [
      { text: "same", href: "/a" },
      { text: "same", href: "/a" },
      { text: "same", href: "/b" },
    ],
  };
  expect(cleanResult(input, { trim: false, deduplicate: false })).toEqual(input);
  const result = cleanResult(input, { trim: true, deduplicate: true });
  expect(result.headings).toEqual(["A"]);
  expect(result.links).toHaveLength(2);
  expect(serializeResult(result, "csv")).toContain('"中文,""标题""\nnext"');
});

it("keeps evicting archives across a restart through the durable artifact manifest", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "mimesis-gateway-restart-"));
  const db = new RuntimeDatabase(join(root, "runtime.sqlite"));
  context.onTestFinished(() => {
    db.dispatch({ method: "close" });
  });
  const connect = () =>
    new SqliteGatewayRepository(root, {
      async loadGateway() {
        const value = db.dispatch({ method: "gateway.load" });
        if (value === null) return undefined;
        return gatewayStateSchema.parse(value);
      },
      async saveGateway(state, artifacts, evicted = []) {
        db.dispatch({ method: "gateway.save", state, artifacts, evicted });
      },
      async loadArtifacts() {
        return db.dispatch({ method: "artifacts.load" }) as never[];
      },
    });
  const first = await GatewayQueue.open(connect(), {
    resolve: () => execution,
    execute: async () => completedRun(),
  });
  first.start();
  const initial = await first.submit(submission);
  await vi.waitFor(() => expect(first.get(initial.job.id).status).toBe("succeeded"));
  await first.close();
  // A fresh process only knows the archive through the artifacts manifest loaded on start.
  const restarted = connect();
  const second = await GatewayQueue.open(
    restarted,
    {
      resolve: () => execution,
      execute: async () => completedRun(),
    },
    { maxPending: 10, maxStored: 1 },
  );
  second.start();
  const latest = await second.submit(submission);
  await vi.waitFor(() => expect(second.get(latest.job.id).status).toBe("succeeded"));
  await second.close();
  const instanceJobs = join(root, "instances", execution.instance.id, "jobs");
  expect(await readdir(instanceJobs)).toEqual([latest.job.id]);
  const bytes = [...restarted.artifactBytesByJob().values()].reduce(
    (total, value) => total + value,
    0,
  );
  expect(bytes).toBeGreaterThan(0);
});
