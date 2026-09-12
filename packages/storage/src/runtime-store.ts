import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { AppError, type GatewayState, gatewayStateSchema, z } from "@clawler/contracts";
import type { WorkspaceRepository } from "./index";
import { legacySnapshot } from "./legacy-import";
import {
  type Artifact,
  artifactSchema,
  type RuntimeCommand,
  runtimeResponseSchema,
} from "./runtime-protocol";
import { type StoredState, stateSchema } from "./state";

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

/** One worker owns the database; the desktop process only exchanges validated messages. */
export class RuntimeStore implements WorkspaceRepository {
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private unavailable = false;
  private closing: Promise<void> | undefined;
  private constructor(private readonly worker: Worker) {
    worker.on("message", (input: unknown) => {
      const response = runtimeResponseSchema.safeParse(input);
      if (!response.success) {
        this.fail();
        void worker.terminate();
        return;
      }
      const pending = this.pending.get(response.data.id);
      if (!pending) return;
      this.pending.delete(response.data.id);
      clearTimeout(pending.timer);
      if (response.data.ok) pending.resolve(response.data.value);
      else pending.reject(new AppError("STORAGE_FAILED"));
    });
    worker.on("error", () => this.fail());
    worker.on("exit", () => this.fail());
  }
  static async open(root: string, workerFile: string): Promise<RuntimeStore> {
    const file = join(root, "runtime", "runtime.sqlite");
    await mkdir(dirname(file), { recursive: true });
    const store = new RuntimeStore(new Worker(workerFile, { workerData: { file } }));
    try {
      if (!z.boolean().parse(await store.send({ method: "initialized" }))) {
        const snapshot = await legacySnapshot(root);
        await store.send({ method: "initialize", ...snapshot });
      }
      return store;
    } catch (error) {
      store.fail();
      await store.worker.terminate();
      throw new AppError("STORAGE_FAILED", { cause: error });
    }
  }
  private fail(): void {
    this.unavailable = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AppError("STORAGE_FAILED"));
    }
    this.pending.clear();
  }
  private send(command: RuntimeCommand): Promise<unknown> {
    if (this.unavailable || this.closing) return Promise.reject(new AppError("STORAGE_FAILED"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail();
        void this.worker.terminate();
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.worker.postMessage({ id, command });
      } catch {
        this.fail();
        void this.worker.terminate();
      }
    });
  }
  async load(): Promise<StoredState | undefined> {
    const state = await this.send({ method: "workspace.load" });
    if (state === null) return undefined;
    return stateSchema.parse(state);
  }
  async save(state: StoredState): Promise<void> {
    await this.send({ method: "workspace.save", state: stateSchema.parse(state) });
  }
  async loadGateway(): Promise<GatewayState | undefined> {
    const state = await this.send({ method: "gateway.load" });
    if (state === null) return undefined;
    return gatewayStateSchema.parse(state);
  }
  async loadArtifacts(): Promise<Artifact[]> {
    return z.array(artifactSchema).parse(await this.send({ method: "artifacts.load" }));
  }
  async saveGateway(
    state: GatewayState,
    artifacts: Artifact[],
    evicted: string[] = [],
  ): Promise<void> {
    await this.send({
      method: "gateway.save",
      state: gatewayStateSchema.parse(state),
      artifacts,
      evicted,
    });
  }
  close(): Promise<void> {
    if (!this.closing) {
      const response = this.send({ method: "close" });
      this.closing = response
        .then(() => undefined)
        .finally(async () => {
          this.unavailable = true;
          await this.worker.terminate();
        });
    }
    return this.closing;
  }
}
