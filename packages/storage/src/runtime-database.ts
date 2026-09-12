import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import {
  AppError,
  type GatewayState,
  gatewayStateSchema,
  type Run,
  runSchema,
} from "@clawler/contracts";
import { type Artifact, type RuntimeCommand, runtimeCommandSchema } from "./runtime-protocol";
import { type StoredState, stateSchema } from "./state";

const applicationId = 0x4d494d45;
const schema = `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL, position INTEGER NOT NULL) STRICT;
CREATE TABLE instances (id TEXT PRIMARY KEY, name TEXT NOT NULL, scriptId TEXT NOT NULL, profileId TEXT NOT NULL REFERENCES profiles(id),
  targetUrl TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
  workflow TEXT, position INTEGER NOT NULL) STRICT;
CREATE TABLE runs (id TEXT PRIMARY KEY, instanceId TEXT NOT NULL, scriptId TEXT NOT NULL, version TEXT NOT NULL, profileId TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','cancelled')), startedAt TEXT NOT NULL, finishedAt TEXT, result TEXT, errorCode TEXT) STRICT;
CREATE INDEX runs_instance_time ON runs(instanceId,startedAt);
CREATE TABLE steps (id TEXT NOT NULL, runId TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, position INTEGER NOT NULL,
  kind TEXT NOT NULL, status TEXT NOT NULL, startedAt TEXT NOT NULL, finishedAt TEXT, PRIMARY KEY(runId,id), UNIQUE(runId,position)) STRICT;
CREATE TABLE workspace_runs (runId TEXT PRIMARY KEY REFERENCES runs(id), position INTEGER NOT NULL UNIQUE) STRICT;
CREATE TABLE gateway_jobs (id TEXT PRIMARY KEY, idempotencyKey TEXT UNIQUE, submission TEXT NOT NULL, execution TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')), createdAt TEXT NOT NULL, startedAt TEXT,
  finishedAt TEXT, errorCode TEXT, cancelRequested INTEGER NOT NULL CHECK(cancelRequested IN (0,1)), runId TEXT REFERENCES runs(id), position INTEGER NOT NULL UNIQUE) STRICT;
CREATE INDEX gateway_status_order ON gateway_jobs(status,position);
CREATE TABLE artifacts (path TEXT PRIMARY KEY, jobId TEXT NOT NULL REFERENCES gateway_jobs(id) ON DELETE CASCADE, bytes INTEGER NOT NULL CHECK(bytes>=0), sha256 TEXT NOT NULL) STRICT;
CREATE INDEX artifacts_job ON artifacts(jobId);
`;

type Row = Record<string, SQLOutputValue>;
function parseJson(value: SQLOutputValue | undefined): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new AppError("STORAGE_FAILED");
  return JSON.parse(value);
}
function json(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

/** Used only by the storage worker (and direct database integration tests). */
export class RuntimeDatabase {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file, { timeout: 5000 });
    try {
      const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version);
      const identity = Number(this.db.prepare("PRAGMA application_id").get()?.application_id);
      if (version !== 0 && (version !== 1 || identity !== applicationId))
        throw new AppError("STORAGE_FAILED");
      if (
        version === 0 &&
        (identity !== 0 ||
          this.db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .all().length)
      )
        throw new AppError("STORAGE_FAILED");
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      if (version === 0)
        this.transaction(() => {
          this.db.exec(schema);
          this.db.exec(`PRAGMA application_id=${applicationId}; PRAGMA user_version=1;`);
        });
      if (this.db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
        throw new AppError("STORAGE_FAILED");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private setting(key: string): string | undefined {
    const value = this.db.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value;
    if (typeof value === "string") return value;
  }
  private setSetting(key: string, value: string) {
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  private put(table: string, row: Record<string, SQLInputValue>, primary = "id") {
    const columns = Object.keys(row);
    const updates = columns
      .filter((name) => name !== primary)
      .map((name) => `${name}=excluded.${name}`);
    this.db
      .prepare(
        `INSERT INTO ${table}(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")}) ON CONFLICT(${primary}) DO UPDATE SET ${updates.join(",")}`,
      )
      .run(...Object.values(row));
  }
  private saveRun(input: Run) {
    const { steps, result, ...run } = runSchema.parse(input);
    // Preserve a completed shared run when another snapshot still contains its running state.
    const previous = this.db
      .prepare("SELECT status,instanceId,scriptId,version,profileId FROM runs WHERE id=?")
      .get(run.id);
    if (
      previous &&
      (previous.instanceId !== run.instanceId ||
        previous.scriptId !== run.scriptId ||
        previous.version !== run.version ||
        previous.profileId !== run.profileId)
    )
      throw new AppError("STORAGE_FAILED");
    if (previous && previous.status !== "running" && run.status === "running") return;
    if (previous && JSON.stringify(this.loadRun(run.id)) === JSON.stringify(runSchema.parse(input)))
      return;
    this.put("runs", { ...run, result: json(result) });
    this.db.prepare("DELETE FROM steps WHERE runId=?").run(run.id);
    steps.forEach((step, position) => {
      this.db
        .prepare(
          "INSERT INTO steps(id,runId,position,kind,status,startedAt,finishedAt) VALUES (?,?,?,?,?,?,?)",
        )
        .run(step.id, run.id, position, step.kind, step.status, step.startedAt, step.finishedAt);
    });
  }
  private loadRun(id: string): Run {
    const run = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id);
    if (!run) throw new AppError("STORAGE_FAILED");
    const steps = this.db
      .prepare(
        "SELECT id,kind,status,startedAt,finishedAt FROM steps WHERE runId=? ORDER BY position",
      )
      .all(id);
    return runSchema.parse({ ...run, result: parseJson(run.result), steps });
  }
  private writeWorkspace(input: StoredState) {
    const state = stateSchema.parse(input);
    state.profiles.forEach((profile, position) => {
      this.put("profiles", { ...profile, position });
    });
    state.instances.forEach((instance, position) => {
      this.put("instances", {
        ...instance,
        enabled: Number(instance.enabled),
        workflow: json(instance.workflow),
        position,
      });
    });
    const instanceIds = new Set(state.instances.map((entry) => entry.id));
    for (const row of this.db.prepare("SELECT id FROM instances").all())
      if (!instanceIds.has(String(row.id)))
        this.db.prepare("DELETE FROM instances WHERE id=?").run(String(row.id));
    const profileIds = new Set(state.profiles.map((entry) => entry.id));
    for (const row of this.db.prepare("SELECT id FROM profiles").all())
      if (!profileIds.has(String(row.id)))
        this.db.prepare("DELETE FROM profiles WHERE id=?").run(String(row.id));
    this.db.exec("DELETE FROM workspace_runs");
    state.runs.forEach((run, position) => {
      this.saveRun(run);
      this.db
        .prepare("INSERT INTO workspace_runs(runId,position) VALUES (?,?)")
        .run(run.id, position);
    });
    this.setSetting("selectedProfileId", state.selectedProfileId);
    this.setSetting("workspaceReady", "1");
  }
  private readWorkspace(): StoredState | null {
    if (!this.setting("workspaceReady")) return null;
    const profiles = this.db
      .prepare("SELECT id,name,createdAt FROM profiles ORDER BY position")
      .all();
    const instances = (
      this.db.prepare("SELECT * FROM instances ORDER BY position").all() as Row[]
    ).map((row) => {
      const value: Record<string, unknown> = { ...row, enabled: row.enabled === 1 };
      delete value.position;
      delete value.workflow;
      if (row.workflow !== null) value.workflow = parseJson(row.workflow);
      return value;
    });
    const runs = (
      this.db.prepare("SELECT runId FROM workspace_runs ORDER BY position").all() as Row[]
    ).map((row) => this.loadRun(String(row.runId)));
    return stateSchema.parse({
      schemaVersion: 3,
      profiles,
      instances,
      runs,
      selectedProfileId: this.setting("selectedProfileId"),
    });
  }
  private writeGateway(input: GatewayState, artifacts: Artifact[], evicted: string[]) {
    const state = gatewayStateSchema.parse(input);
    // Queue ordering is immutable for existing jobs; removal happens only through explicit retention eviction.
    const existingIds = new Set(
      (this.db.prepare("SELECT id FROM gateway_jobs").all() as Row[]).map((row) => String(row.id)),
    );
    const ids = new Set(state.jobs.map((job) => job.id));
    for (const job of evicted) {
      if (!existingIds.has(job) || ids.has(job)) throw new AppError("STORAGE_FAILED");
      const row = this.db.prepare("SELECT status FROM gateway_jobs WHERE id=?").get(job) as
        | Row
        | undefined;
      if (!row || row.status === "queued" || row.status === "running")
        throw new AppError("STORAGE_FAILED");
    }
    if ([...existingIds].some((id) => !ids.has(id) && !evicted.includes(id)))
      throw new AppError("STORAGE_FAILED");
    const evict = this.db.prepare(
      "DELETE FROM gateway_jobs WHERE id=? AND status IN ('succeeded','failed','cancelled')",
    );
    for (const job of evicted) {
      // Artifacts rows cascade; the shared run row is dropped when no job or workspace view references it.
      const orphaned = this.db
        .prepare(
          "SELECT runId FROM gateway_jobs WHERE id=? AND runId IS NOT NULL AND runId NOT IN (SELECT runId FROM workspace_runs)",
        )
        .get(job) as Row | undefined;
      evict.run(job);
      if (orphaned?.runId)
        this.db
          .prepare(
            "DELETE FROM runs WHERE id=? AND id NOT IN (SELECT runId FROM gateway_jobs) AND id NOT IN (SELECT runId FROM workspace_runs)",
          )
          .run(String(orphaned.runId));
    }
    state.jobs.forEach((job, position) => {
      if (
        job.run &&
        (job.run.instanceId !== job.execution.instance.id ||
          job.run.profileId !== job.execution.instance.profileId ||
          job.run.scriptId !== job.execution.instance.scriptId ||
          job.run.version !== job.execution.scriptVersion)
      )
        throw new AppError("STORAGE_FAILED");
      if (job.run) this.saveRun(job.run);
      this.put("gateway_jobs", {
        id: job.id,
        idempotencyKey: job.idempotencyKey,
        submission: json(job.submission),
        execution: json(job.execution),
        status: job.status,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        errorCode: job.errorCode,
        cancelRequested: Number(job.cancelRequested),
        runId: job.run?.id ?? null,
        position,
      });
    });
    for (const artifact of artifacts) {
      const job = state.jobs.find((entry) => entry.id === artifact.jobId);
      if (
        !job ||
        !["succeeded", "failed", "cancelled"].includes(job.status) ||
        !artifact.path.startsWith(`instances/${job.execution.instance.id}/jobs/${job.id}/`)
      )
        throw new AppError("STORAGE_FAILED");
      this.put("artifacts", artifact, "path");
    }
    this.setSetting("gatewayReady", "1");
  }
  private readGateway(): GatewayState | null {
    if (!this.setting("gatewayReady")) return null;
    const jobs = this.db
      .prepare("SELECT * FROM gateway_jobs ORDER BY position")
      .all()
      .map((row: Row) => {
        let run: Run | null = null;
        if (row.runId !== null) run = this.loadRun(String(row.runId));
        return {
          ...row,
          submission: parseJson(row.submission),
          execution: parseJson(row.execution),
          cancelRequested: row.cancelRequested === 1,
          run,
        };
      });
    return gatewayStateSchema.parse({ schemaVersion: 1, jobs });
  }
  private readArtifacts(): Artifact[] {
    return (this.db.prepare("SELECT * FROM artifacts ORDER BY path").all() as Row[]).map((row) => ({
      jobId: String(row.jobId),
      path: String(row.path),
      bytes: Number(row.bytes),
      sha256: String(row.sha256),
    }));
  }
  dispatch(input: RuntimeCommand): unknown {
    const command = runtimeCommandSchema.parse(input);
    switch (command.method) {
      case "initialized":
        return this.setting("initialized") === "1";
      case "initialize":
        return this.transaction(() => {
          if (this.setting("initialized")) return null;
          if (command.workspace) this.writeWorkspace(command.workspace);
          if (command.gateway) this.writeGateway(command.gateway, command.artifacts ?? [], []);
          this.setSetting("initialized", "1");
          return null;
        });
      case "workspace.load":
        return this.readWorkspace();
      case "workspace.save":
        return this.transaction(() => {
          this.writeWorkspace(command.state);
          return null;
        });
      case "gateway.load":
        return this.readGateway();
      case "artifacts.load":
        return this.readArtifacts();
      case "gateway.save":
        return this.transaction(() => {
          this.writeGateway(command.state, command.artifacts, command.evicted ?? []);
          return null;
        });
      case "close":
        this.db.close();
        return null;
    }
  }
}
