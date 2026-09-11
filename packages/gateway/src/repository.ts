import { createHash } from "node:crypto";
import { join } from "node:path";
import { AppError, type GatewayJob, type GatewayState, gatewayJobSchema } from "@clawler/contracts";
import { atomicWrite } from "@clawler/storage/atomic-file";
import type { RuntimeStore } from "@clawler/storage/runtime";
import type { Artifact } from "@clawler/storage/runtime-protocol";
import { cleanResult, serializeResult } from "./results";

export interface GatewayRepository {
  load(): Promise<GatewayState | undefined>;
  save(state: GatewayState): Promise<void>;
  archive(job: GatewayJob): Promise<void>;
}

/** Files are durable before the queue commits their manifest and terminal job state together. */
export class SqliteGatewayRepository implements GatewayRepository {
  private readonly staged = new Map<string, Artifact[]>();
  constructor(
    private readonly root: string,
    private readonly store: Pick<RuntimeStore, "loadGateway" | "saveGateway">,
  ) {}
  load(): Promise<GatewayState | undefined> {
    return this.store.loadGateway();
  }
  async save(state: GatewayState): Promise<void> {
    await this.store.saveGateway(state, [...this.staged.values()].flat());
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
}
