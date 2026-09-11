import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AppError, type StorageLocation, z } from "@clawler/contracts";
import { atomicWrite } from "./atomic-file";
import { contains, directoryPath, lockDirectory, writeBootstrap } from "./location-files";
import { migrateDirectory, transferSchema, validateDestination } from "./location-migration";

const configurationSchema = z.object({
  version: z.literal(1),
  directory: z.string().nullable(),
  pending: transferSchema.nullable(),
});
type Configuration = z.infer<typeof configurationSchema>;

export class StorageLocationManager {
  static hasPending(configurationRoot: string): boolean {
    try {
      const file = join(configurationRoot, "launcher.json");
      return configurationSchema.parse(JSON.parse(readFileSync(file, "utf8"))).pending !== null;
    } catch {
      return false;
    }
  }
  static cancelPending(configurationRoot: string): void {
    const file = join(configurationRoot, "launcher.json");
    if (!existsSync(file)) return;
    const state = configurationSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    writeBootstrap(file, { ...state, pending: null });
  }
  private configuration: Configuration;
  private readonly file: string;
  private release: (() => void) | undefined;
  private changing = false;
  private pendingWrite: Promise<void> = Promise.resolve();
  readonly current: string;
  readonly source: StorageLocation["source"];

  constructor(
    readonly configurationRoot: string,
    defaultRoot: string,
    override?: string,
  ) {
    this.file = join(configurationRoot, "launcher.json");
    this.configuration = { version: 1, directory: null, pending: null };
    if (existsSync(this.file))
      this.configuration = configurationSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
    let root = defaultRoot;
    this.source = "default";
    if (this.configuration.directory) {
      root = this.configuration.directory;
      this.source = "configuration";
    }
    if (override) {
      root = override;
      this.source = "environment";
    }
    root = directoryPath(root);
    if (contains(root, configurationRoot) || contains(configurationRoot, root))
      throw new AppError("STORAGE_PATH_INVALID");
    if (!existsSync(root) && this.source === "configuration")
      throw new AppError("STORAGE_PATH_INVALID");
    mkdirSync(root, { recursive: true });
    this.release = lockDirectory(root);
    try {
      const transfer = this.configuration.pending;
      if (!override && transfer) {
        if (directoryPath(transfer.source) !== root) throw new AppError("STORAGE_PATH_INVALID");
        migrateDirectory(transfer, configurationRoot);
        const releaseTarget = lockDirectory(transfer.target);
        try {
          const next: Configuration = { version: 1, directory: transfer.target, pending: null };
          writeBootstrap(this.file, next);
          this.configuration = next;
        } catch (error) {
          releaseTarget();
          throw error;
        }
        this.release();
        this.release = releaseTarget;
        root = transfer.target;
        this.source = "configuration";
      }
      this.current = root;
    } catch (error) {
      this.release();
      throw error;
    }
  }

  info(): StorageLocation {
    let pending: string | null = null;
    if (this.source !== "environment") pending = this.configuration.pending?.target ?? null;
    return { current: this.current, source: this.source, pending };
  }

  async schedule(path: string): Promise<StorageLocation> {
    if (this.source === "environment") throw new AppError("FORBIDDEN");
    if (this.changing) throw new AppError("BUSY");
    this.changing = true;
    try {
      const target = validateDestination(this.current, path, this.configurationRoot);
      const probe = join(dirname(target), `.mimesis-probe-${crypto.randomUUID()}`);
      try {
        writeFileSync(probe, "", { flag: "wx" });
      } finally {
        if (existsSync(probe)) unlinkSync(probe);
      }
      const pending = { id: crypto.randomUUID(), source: this.current, target };
      const next = { ...this.configuration, pending };
      this.pendingWrite = atomicWrite(this.file, JSON.stringify(next, null, 2));
      await this.pendingWrite;
      this.configuration = next;
      return this.info();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("STORAGE_FAILED", { cause: error });
    } finally {
      this.changing = false;
    }
  }

  async cancel(): Promise<StorageLocation> {
    if (this.source === "environment") throw new AppError("FORBIDDEN");
    if (this.changing) throw new AppError("BUSY");
    this.changing = true;
    try {
      const next = { ...this.configuration, pending: null };
      this.pendingWrite = atomicWrite(this.file, JSON.stringify(next, null, 2));
      await this.pendingWrite;
      this.configuration = next;
      return this.info();
    } catch (error) {
      throw new AppError("STORAGE_FAILED", { cause: error });
    } finally {
      this.changing = false;
    }
  }
  close(): void {
    this.release?.();
    this.release = undefined;
  }
  async flush(): Promise<void> {
    await this.pendingWrite;
  }
}
