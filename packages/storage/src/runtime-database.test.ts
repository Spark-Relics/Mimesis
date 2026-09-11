import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type GatewayState, gatewayJobSchema } from "@clawler/contracts";
import { expect, it, type TestContext } from "vitest";
import { completedRun, execution, submission } from "../../gateway/src/fixtures.test-support";
import { RuntimeDatabase } from "./runtime-database";
import { type StoredState, stateSchema } from "./state";

function workspace(): StoredState {
  return {
    schemaVersion: 3,
    profiles: [
      {
        id: execution.instance.profileId,
        name: "Default",
        createdAt: execution.instance.createdAt,
      },
    ],
    selectedProfileId: execution.instance.profileId,
    instances: [execution.instance],
    runs: [],
  };
}
function gateway(): GatewayState {
  return {
    schemaVersion: 1,
    jobs: [
      gatewayJobSchema.parse({
        id: crypto.randomUUID(),
        idempotencyKey: "request-1",
        submission,
        execution,
        status: "succeeded",
        createdAt: execution.instance.createdAt,
        startedAt: execution.instance.createdAt,
        finishedAt: execution.instance.createdAt,
        errorCode: null,
        run: completedRun(),
      }),
    ],
  };
}
async function database(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "mimesis-sqlite-"));
  const file = join(root, "runtime.sqlite");
  const db = new RuntimeDatabase(file);
  const inspection = new DatabaseSync(file);
  context.onTestFinished(() => {
    inspection.close();
    db.dispatch({ method: "close" });
  });
  return { db, inspection, file };
}

it("round trips normalized workspace, shared runs, step ordering and gateway idempotency", async (context) => {
  const { db, inspection } = await database(context);
  const state = workspace();
  const queue = gateway();
  const run = queue.jobs[0]?.run;
  if (!run) throw new Error("Missing fixture");
  run.steps = [
    {
      id: "navigate",
      kind: "navigate",
      status: "succeeded",
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    },
  ];
  state.runs = [run, { ...run, id: crypto.randomUUID() }];
  db.dispatch({ method: "initialize", workspace: state, gateway: queue });
  expect(db.dispatch({ method: "workspace.load" })).toEqual(state);
  expect(db.dispatch({ method: "gateway.load" })).toEqual(queue);
  expect(inspection.prepare("SELECT COUNT(*) AS count FROM runs").get()?.count).toBe(2);
  expect(inspection.prepare("SELECT COUNT(*) AS count FROM steps").get()?.count).toBe(2);
  expect(inspection.prepare("SELECT idempotencyKey FROM gateway_jobs").get()?.idempotencyKey).toBe(
    "request-1",
  );
  const stale = structuredClone(state);
  stale.runs[0] = { ...run, status: "running", result: null, finishedAt: null };
  db.dispatch({ method: "workspace.save", state: stale });
  expect(stateSchema.parse(db.dispatch({ method: "workspace.load" })).runs[0]).toEqual(run);
});

it("rolls back partial workspace writes on a real SQL failure and can retry", async (context) => {
  const { db, inspection } = await database(context);
  const state = workspace();
  db.dispatch({ method: "initialize", workspace: state, gateway: null });
  inspection.exec(
    "CREATE TRIGGER reject_instance BEFORE UPDATE ON instances BEGIN SELECT RAISE(ABORT,'injected disk failure'); END;",
  );
  const changed = structuredClone(state);
  changed.profiles = changed.profiles.map((profile) => ({ ...profile, name: "Changed" }));
  expect(() => db.dispatch({ method: "workspace.save", state: changed })).toThrow();
  expect(db.dispatch({ method: "workspace.load" })).toEqual(state);
  inspection.exec("DROP TRIGGER reject_instance");
  db.dispatch({ method: "workspace.save", state: changed });
  expect(db.dispatch({ method: "workspace.load" })).toEqual(changed);
});

it("imports both domains atomically and sets the one-time marker only after success", async (context) => {
  const { db, inspection } = await database(context);
  inspection.exec(
    "CREATE TRIGGER reject_job BEFORE INSERT ON gateway_jobs BEGIN SELECT RAISE(ABORT,'injected failure'); END;",
  );
  expect(() =>
    db.dispatch({ method: "initialize", workspace: workspace(), gateway: gateway() }),
  ).toThrow();
  expect(db.dispatch({ method: "initialized" })).toBe(false);
  expect(db.dispatch({ method: "workspace.load" })).toBeNull();
  inspection.exec("DROP TRIGGER reject_job");
  db.dispatch({ method: "initialize", workspace: workspace(), gateway: gateway() });
  db.dispatch({ method: "initialize", workspace: null, gateway: null });
  expect(db.dispatch({ method: "workspace.load" })).toEqual(workspace());
  expect(db.dispatch({ method: "initialized" })).toBe(true);
});

it("commits terminal state and artifact manifests together, rejects wrong ownership", async (context) => {
  const { db, inspection } = await database(context);
  const state = gateway();
  const job = state.jobs[0];
  if (!job) throw new Error("Missing fixture");
  const queued = structuredClone(state);
  queued.jobs = [{ ...job, status: "queued", run: null, startedAt: null, finishedAt: null }];
  db.dispatch({ method: "gateway.save", state: queued, artifacts: [] });
  const artifact = {
    jobId: job.id,
    path: `instances/${crypto.randomUUID()}/jobs/${job.id}/job.json`,
    bytes: 12,
    sha256: "a".repeat(64),
  };
  expect(() => db.dispatch({ method: "gateway.save", state, artifacts: [artifact] })).toThrow();
  expect(db.dispatch({ method: "gateway.load" })).toEqual(queued);
  expect(inspection.prepare("SELECT COUNT(*) AS count FROM runs").get()?.count).toBe(0);
  artifact.path = `instances/${job.execution.instance.id}/jobs/${job.id}/job.json`;
  db.dispatch({ method: "gateway.save", state, artifacts: [artifact] });
  expect(inspection.prepare("SELECT * FROM artifacts").get()).toEqual(artifact);
  expect(db.dispatch({ method: "gateway.load" })).toEqual(state);
});

it("refuses newer or corrupt databases without replacing their bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mimesis-invalid-db-"));
  const file = join(root, "runtime.sqlite");
  const newer = new DatabaseSync(file);
  newer.exec("PRAGMA user_version=99");
  newer.close();
  const bytes = await readFile(file);
  expect(() => new RuntimeDatabase(file)).toThrow();
  expect(await readFile(file)).toEqual(bytes);
  await writeFile(file, "broken database");
  expect(() => new RuntimeDatabase(file)).toThrow();
  expect(await readFile(file, "utf8")).toBe("broken database");
});

it("rejects duplicate workspace IDs and conflicting ownership without losing the previous state", async (context) => {
  const { db } = await database(context);
  const state = workspace();
  const queue = gateway();
  db.dispatch({ method: "initialize", workspace: state, gateway: queue });
  expect(() =>
    db.dispatch({
      method: "workspace.save",
      state: { ...state, profiles: [...state.profiles, ...state.profiles] },
    }),
  ).toThrow();
  const job = queue.jobs[0];
  if (!job?.run) throw new Error("Missing fixture");
  const invalid = { ...job.run, instanceId: crypto.randomUUID() };
  expect(() =>
    db.dispatch({ method: "workspace.save", state: { ...state, runs: [invalid] } }),
  ).toThrow();
  expect(() =>
    db.dispatch({
      method: "gateway.save",
      state: { ...queue, jobs: [{ ...job, run: invalid }] },
      artifacts: [],
    }),
  ).toThrow();
  expect(db.dispatch({ method: "workspace.load" })).toEqual(state);
  expect(db.dispatch({ method: "gateway.load" })).toEqual(queue);
});
