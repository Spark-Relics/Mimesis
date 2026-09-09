import { AppError } from "@clawler/contracts";
import type { ScriptDefinition } from "@clawler/script-sdk";
import { collectPages } from "./collection";
import { inspectPage } from "./page-inspector";

export { resolveWorkflow } from "./collection";

export const collectionScript: ScriptDefinition = {
  manifest: {
    id: "collection-workflow",
    version: "1.0.0",
    sdkVersion: 1,
    ai: "disabled",
    implementation: "bundled",
  },
  timeoutMs: 120_000,
  execute: collectPages,
};

export const pageInspector: ScriptDefinition = {
  manifest: {
    id: "page-inspector",
    version: "1.0.0",
    sdkVersion: 1,
    ai: "disabled",
    implementation: "bundled",
  },
  execute: inspectPage,
};

export class ScriptRegistry {
  private readonly scripts = new Map<string, ScriptDefinition>([
    [pageInspector.manifest.id, pageInspector],
    [collectionScript.manifest.id, collectionScript],
  ]);

  list() {
    return [...this.scripts.values()].map((script) => script.manifest);
  }

  get(id: string): ScriptDefinition {
    const script = this.scripts.get(id);
    if (!script) throw new AppError("NOT_FOUND");
    return script;
  }
}
