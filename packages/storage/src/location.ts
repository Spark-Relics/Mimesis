import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AppError, type StorageLocation, z } from "@clawler/contracts";
import { atomicWrite } from "./atomic-file";
import {
  type BackupPlan,
  backupPlanSchema,
  createBackup,
  readBackupMarker,
  restoreBackup,
  validateBackupTarget,
} from "./backup";
import { contains, directoryPath, lockDirectory, writeBootstrap } from "./location-files";
import { migrateDirectory, transferSchema, validateDestination } from "./location-migration";

const configurationSchema = z.object({
  version: z.literal(1),
  directory: z.string().nullable(),
  pending: transferSchema.nullable(),
  // Older launchers did not carry backup plans; treat them as none pending.
  pendingBackup: backupPlanSchema.nullable().default(null),
});
type Configuration = z.infer<typeof configurationSchema>;

export class StorageLocationManager {
  static hasPending(configurationRoot: string): boolean {
    try {
      const file = join(configurationRoot, "launcher.json");
      const state = configurationSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      return state.pending !== null || state.pendingBackup !== null;
    } catch {
      return false;
    }
  }
  static cancelPending(configurationRoot: string): void {
    const file = join(configurationRoot, "launcher.json");
    if (!existsSync(file)) return;
    const state = configurationSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    writeBootstrap(file, { ...state, pending: null, pendingBackup: null });
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
    this.configuration = { version: 1, directory: null, pending: null, pendingBackup: null };
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
      if (!override && this.configuration.pending && this.configuration.pendingBackup)
        throw new AppError("BUSY");
      const transfer = this.configuration.pending;
      if (!override && transfer) {
        if (directoryPath(transfer.source) !== root) throw new AppError("STORAGE_PATH_INVALID");
        migrateDirectory(transfer, configurationRoot);
        const releaseTarget = lockDirectory(transfer.target);
        try {
          const next: Configuration = {
            version: 1,
            directory: transfer.target,
            pending: null,
            pendingBackup: null,
          };
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
      if (!override) {
        const restored = this.runPendingBackup(root);
        if (restored) {
          root = restored;
          this.source = "configuration";
        }
      }
      this.current = root;
    } catch (error) {
      this.release();
      throw error;
    }
  }

  info(): StorageLocation {
    let pending: string | null = null;
    let plan: BackupPlan | null = null;
    if (this.source !== "environment") {
      pending = this.configuration.pending?.target ?? null;
      plan = this.configuration.pendingBackup;
    }
    return {
      current: this.current,
      source: this.source,
      pending,
      pendingBackup: plan?.target ?? null,
      pendingBackupKind: plan?.kind ?? null,
    };
  }

  private commit(configuration: Configuration): Promise<void> {
    this.pendingWrite = atomicWrite(this.file, JSON.stringify(configuration, null, 2));
    return this.pendingWrite.then(() => {
      this.configuration = configuration;
    });
  }

  /**
   * Schedule an offline backup or restore for the next launch. Directory
   * migration and backup/restore are mutually exclusive; each launch performs
   * at most one heavy transfer.
   */
  async scheduleBackup(input: {
    kind: "backup" | "restore";
    path: string;
  }): Promise<StorageLocation> {
    if (this.source === "environment") throw new AppError("FORBIDDEN");
    if (this.changing || this.configuration.pending || this.configuration.pendingBackup)
      throw new AppError("BUSY");
    this.changing = true;
    try {
      const id = crypto.randomUUID();
      let plan: BackupPlan;
      if (input.kind === "backup") {
        const target = validateBackupTarget(this.current, input.path, this.configurationRoot);
        plan = { kind: "backup", id, target };
      } else {
        // The restore source must be a complete, verified backup directory.
        const source = directoryPath(input.path.trim());
        if (
          !existsSync(source) ||
          contains(this.current, source) ||
          contains(source, this.current) ||
          contains(source, this.configurationRoot) ||
          contains(this.configurationRoot, source)
        )
          throw new AppError("STORAGE_PATH_INVALID");
        const receipt = readBackupMarker(source);
        if (receipt.plan.kind !== "backup" || !receipt.complete)
          throw new AppError("STORAGE_FAILED");
        const target = validateBackupTarget(
          this.current,
          join(dirname(this.current), `mimesis-restored-${id}`),
          this.configurationRoot,
        );
        plan = { kind: "restore", id, source, target };
      }
      await this.commit({ ...this.configuration, pendingBackup: plan });
      return this.info();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("STORAGE_FAILED", { cause: error });
    } finally {
      this.changing = false;
    }
  }

  async cancelBackup(): Promise<StorageLocation> {
    if (this.source === "environment") throw new AppError("FORBIDDEN");
    if (this.changing) throw new AppError("BUSY");
    this.changing = true;
    try {
      await this.commit({ ...this.configuration, pendingBackup: null });
      return this.info();
    } catch (error) {
      throw new AppError("STORAGE_FAILED", { cause: error });
    } finally {
      this.changing = false;
    }
  }

  async schedule(path: string): Promise<StorageLocation> {
    if (this.source === "environment") throw new AppError("FORBIDDEN");
    if (this.changing || this.configuration.pendingBackup) throw new AppError("BUSY");
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
      await this.commit({ ...this.configuration, pending });
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
      await this.commit({ ...this.configuration, pending: null });
      return this.info();
    } catch (error) {
      throw new AppError("STORAGE_FAILED", { cause: error });
    } finally {
      this.changing = false;
    }
  }

  /** Execute a pending backup/restore during bootstrap, before any handle exists. */
  private runPendingBackup(root: string): string | null {
    const plan = this.configuration.pendingBackup;
    if (!plan) return null;
    if (plan.kind === "backup") {
      createBackup(root, plan.target, plan.id, this.configurationRoot);
      writeBootstrap(this.file, { ...this.configuration, pendingBackup: null });
      this.configuration = { ...this.configuration, pendingBackup: null };
      return null;
    }
    restoreBackup(plan.source, plan.target, plan.id);
    lockDirectory(plan.target)();
    const next: Configuration = {
      version: 1,
      directory: plan.target,
      pending: null,
      pendingBackup: null,
    };
    writeBootstrap(this.file, next);
    this.configuration = next;
    return plan.target;
  }

  close(): void {
    this.release?.();
    this.release = undefined;
  }
  async flush(): Promise<void> {
    await this.pendingWrite;
  }
}
