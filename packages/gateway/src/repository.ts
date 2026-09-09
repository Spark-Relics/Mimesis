import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AppError,
  type GatewayJob,
  type GatewayState,
  gatewayJobSchema,
  gatewayStateSchema,
} from "@clawler/contracts";
import { cleanResult, serializeResult } from "./results";

export interface GatewayRepository {
  load(): Promise<GatewayState | undefined>;
  save(state: GatewayState): Promise<void>;
  archive(job: GatewayJob): Promise<void>;
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Single-writer repository. Queue acknowledgment follows the atomic durable write. */
export class FileGatewayRepository implements GatewayRepository {
  constructor(private readonly root: string) {}

  async load(): Promise<GatewayState | undefined> {
    try {
      return gatewayStateSchema.parse(
        JSON.parse(await readFile(join(this.root, "gateway.json"), "utf8")),
      );
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return undefined;
      throw new AppError("STORAGE_FAILED", { cause: error });
    }
  }

  async save(state: GatewayState): Promise<void> {
    try {
      await atomicWrite(
        join(this.root, "gateway.json"),
        JSON.stringify(gatewayStateSchema.parse(state), null, 2),
      );
    } catch (error) {
      throw new AppError("STORAGE_FAILED", { cause: error });
    }
  }

  async archive(input: GatewayJob): Promise<void> {
    const job = gatewayJobSchema.parse(input);
    // Only schema-validated UUIDs participate in paths. No caller-supplied filenames.
    const directory = join(this.root, "instances", job.execution.instance.id, "jobs", job.id);
    try {
      if (job.run?.result && job.status === "succeeded") {
        const result = cleanResult(job.run.result, job.submission.cleaning);
        for (const format of ["json", "csv", "ndjson"] as const)
          await atomicWrite(join(directory, `result.${format}`), serializeResult(result, format));
      }
      await atomicWrite(join(directory, "job.json"), JSON.stringify(job, null, 2));
    } catch (error) {
      throw new AppError("STORAGE_FAILED", { cause: error });
    }
  }
}
