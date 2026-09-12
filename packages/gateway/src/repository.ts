import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AppError, type GatewayJob, type GatewayState, gatewayJobSchema } from "@clawler/contracts";
import { atomicWrite } from "@clawler/storage/atomic-file";
import type { RuntimeStore } from "@clawler/storage/runtime";
import type { Artifact } from "@clawler/storage/runtime-protocol";
import { cleanResult, serializeResult } from "./results";

export interface GatewayRepository {
  load(): Promise<GatewayState | undefined>;
  save(state: GatewayState, evicted?: string[]): Promise<void>;
  archive(job: GatewayJob): Promise<void>;
  /** Recorded artifact bytes per job id: durable manifest plus files staged in this process. */
  artifactBytesByJob(): Map<string, number>;
}

/** Files are durable before the queue commits their manifest and terminal job state together. */
export class SqliteGatewayRepository implements GatewayRepository {
  private readonly staged = new Map<string, Artifact[]>();
  /** Every artifact this process can account for: staged since restart plus earlier durable rows. */
  private known = new Map<string, Artifact[]>();
  constructor(
    private readonly root: string,
    private readonly store: Pick<RuntimeStore, "loadGateway" | "saveGateway" | "loadArtifacts">,
  ) {}
  async load(): Promise<GatewayState | undefined> {
    const state = await this.store.loadGateway();
    // Hydrate the durable manifest so retention can still evict archives written before a restart.
    this.known = new Map();
    for (const artifact of await this.store.loadArtifacts()) {
      const group = this.known.get(artifact.jobId);
      if (group) group.push(artifact);
      else this.known.set(artifact.jobId, [artifact]);
    }
    return state;
  }
  async save(state: GatewayState, evicted: string[] = []): Promise<void> {
    // Removing an archive folder is irreversible, so it only runs for jobs with a known manifest.
    for (const job of evicted) {
      const folder = this.known.get(job);
      if (!folder) throw new AppError("STORAGE_FAILED");
      await rm(join(this.root, dirname(folder[0]?.path ?? "")), {
        recursive: true,
        force: true,
      });
      this.known.delete(job);
    }
    for (const [job, artifacts] of this.staged) {
      const existing = this.known.get(job) ?? [];
      this.known.set(
        job,
        existing
          .filter((entry) => !artifacts.some((next) => next.path === entry.path))
          .concat(artifacts),
      );
    }
    await this.store.saveGateway(state, [...this.staged.values()].flat(), evicted);
    this.staged.clear();
  }
  async archive(input: GatewayJob): Promise<void> {
    const job = gatewayJobSchema.parse(input);
    const directory = `instances/${job.execution.instance.id}/jobs/${job.id}`;
    const files: { name: string; content: string }[] = [];
    if (job.run?.result && job.status === "succeeded") {
      const result = cleanResult(job.run.result, job.submission.cleaning);
      for (const format of ["json", "csv", "ndjson"] as const)
        files.push({ name: `result.${format}`, content: serializeResult(result, format) });
    }
    files.push({ name: "job.json", content: JSON.stringify(job, null, 2) });
    const artifacts: Artifact[] = [];
    try {
      for (const file of files) {
        const path = `${directory}/${file.name}`;
        await atomicWrite(join(this.root, path), file.content);
        artifacts.push({
          jobId: job.id,
          path,
          bytes: Buffer.byteLength(file.content),
          sha256: createHash("sha256").update(file.content).digest("hex"),
        });
      }
      this.staged.set(job.id, artifacts);
    } catch (error) {
      throw new AppError("STORAGE_FAILED", { cause: error });
    }
  }
  artifactBytesByJob(): Map<string, number> {
    const bytes = new Map<string, number>();
    for (const [job, artifacts] of this.known)
      bytes.set(
        job,
        artifacts.reduce((total, artifact) => total + artifact.bytes, 0),
      );
    return bytes;
  }
}
