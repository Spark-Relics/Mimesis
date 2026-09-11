import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type GatewayState, gatewayStateSchema } from "@clawler/contracts";
import { decodeState } from "./migrations";
import type { Artifact } from "./runtime-protocol";
import type { StoredState } from "./state";

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
}
async function backup(path: string, content: string): Promise<void> {
  const destination = `${path}.pre-sqlite.backup.json`;
  try {
    await copyFile(path, destination, constants.COPYFILE_EXCL);
  } catch (error) {
    if (
      !(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      ) ||
      (await readFile(destination, "utf8")) !== content
    )
      throw error;
  }
  const handle = await open(destination, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function legacySnapshot(
  root: string,
): Promise<{ workspace: StoredState | null; gateway: GatewayState | null; artifacts: Artifact[] }> {
  const workspaceFile = join(root, "workspace.json");
  const gatewayFile = join(root, "runtime", "gateway.json");
  const [workspaceContent, gatewayContent] = await Promise.all([
    readOptional(workspaceFile),
    readOptional(gatewayFile),
  ]);
  let workspace: StoredState | null = null;
  let gateway: GatewayState | null = null;
  // Validate both before producing any backup or import.
  if (workspaceContent !== undefined) workspace = decodeState(JSON.parse(workspaceContent));
  if (gatewayContent !== undefined) gateway = gatewayStateSchema.parse(JSON.parse(gatewayContent));
  if (workspaceContent !== undefined) await backup(workspaceFile, workspaceContent);
  if (gatewayContent !== undefined) await backup(gatewayFile, gatewayContent);
  const artifacts: Artifact[] = [];
  for (const job of gateway?.jobs ?? []) {
    if (!["succeeded", "failed", "cancelled"].includes(job.status)) continue;
    for (const name of ["job.json", "result.json", "result.csv", "result.ndjson"]) {
      const path = `instances/${job.execution.instance.id}/jobs/${job.id}/${name}`;
      const content = await readOptional(join(root, "runtime", path));
      if (content === undefined) continue;
      artifacts.push({
        jobId: job.id,
        path,
        bytes: Buffer.byteLength(content),
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
  }
  return { workspace, gateway, artifacts };
}
