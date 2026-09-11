import { constants } from "node:fs";
import { copyFile, open, readFile } from "node:fs/promises";
import { AppError, z } from "@clawler/contracts";
import { atomicWrite } from "./atomic-file";
import { decodeState } from "./migrations";
import { type StoredState, stateSchema } from "./state";

export type { StoredState } from "./state";

export interface WorkspaceRepository {
  load(): Promise<StoredState | undefined>;
  save(state: StoredState): Promise<void>;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** Serialized durable snapshots; historical decoding is isolated from runtime services. */
export class JsonWorkspaceRepository implements WorkspaceRepository {
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}

  async load(): Promise<StoredState | undefined> {
    let content: string;
    try {
      content = await readFile(this.file, "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw new AppError("STORAGE_FAILED", { cause: error });
    }
    try {
      const input: unknown = JSON.parse(content);
      const state = decodeState(input);
      const version = z.object({ schemaVersion: z.number() }).parse(input).schemaVersion;
      if (version !== state.schemaVersion) {
        const backup = `${this.file}.v${version}.backup.json`;
        try {
          await copyFile(this.file, backup, constants.COPYFILE_EXCL);
        } catch (error) {
          if (!hasCode(error, "EEXIST") || (await readFile(backup, "utf8")) !== content)
            throw error;
        }
        const handle = await open(backup, "r+");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      return state;
    } catch (error) {
      throw new AppError("STORAGE_FAILED", { cause: error });
    }
  }

  save(state: StoredState): Promise<void> {
    const content = JSON.stringify(stateSchema.parse(state), null, 2);
    const write = async () => {
      try {
        await atomicWrite(this.file, content);
      } catch (error) {
        throw new AppError("STORAGE_FAILED", { cause: error });
      }
    };
    const next = this.writes.then(write);
    this.writes = next.catch(() => undefined);
    return next;
  }
}
