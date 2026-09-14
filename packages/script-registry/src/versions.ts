import { createHash } from "node:crypto";
import {
  AppError,
  type CollectionWorkflow,
  collectionWorkflowSchema,
  type VersionBinding,
  type WorkflowVersion,
  workflowVersionSchema,
} from "@clawler/contracts";

const placeholder = /\{\{([^{}]*)\}\}/gu;

/** Parameter names referenced by a workflow, in first-use order. */
export function parameterNames(workflow: CollectionWorkflow): string[] {
  const names: string[] = [];
  for (const action of workflow.before) {
    if (action.kind !== "fill") continue;
    for (const match of action.value.matchAll(placeholder)) {
      const name = match[1] ?? "";
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(name)) throw new AppError("INVALID_INPUT");
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** Structural checks that must pass before content becomes an immutable version. */
export function validateForPublish(input: unknown): CollectionWorkflow {
  const workflow = collectionWorkflowSchema.parse(input);
  parameterNames(workflow);
  // A stray single brace or unbalanced marker would be sent to the page literally.
  for (const action of workflow.before) {
    if (action.kind !== "fill") continue;
    const stripped = action.value.replace(placeholder, "");
    if (stripped.includes("{{") || stripped.includes("}}"))
      throw new AppError("INVALID_INPUT");
  }
  if (workflow.pagination && workflow.pagination.maxPages < 2) throw new AppError("INVALID_INPUT");
  return workflow;
}

/* Published content is identified by a digest over a canonical projection: object keys are
 * sorted so that key order in the stored JSON never changes the identity of a version. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : 1));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function workflowDigest(targetUrl: string, workflow: CollectionWorkflow): string {
  return createHash("sha256")
    .update(canonical({ targetUrl, workflow: validateForPublish(workflow) }))
    .digest("hex");
}

export function verifyVersion(version: WorkflowVersion): boolean {
  let digest: string;
  try {
    digest = workflowDigest(version.targetUrl, version.workflow);
  } catch {
    return false;
  }
  return digest === version.digest;
}

export function nextVersionNumber(existing: readonly WorkflowVersion[]): number {
  let highest = 0;
  for (const version of existing) highest = Math.max(highest, version.version);
  return highest + 1;
}

export function buildVersion(input: {
  instanceId: string;
  targetUrl: string;
  workflow: CollectionWorkflow;
  note: string;
  publishedAt: string;
  existing: readonly WorkflowVersion[];
}): WorkflowVersion {
  return workflowVersionSchema.parse({
    id: crypto.randomUUID(),
    instanceId: input.instanceId,
    version: nextVersionNumber(input.existing),
    digest: workflowDigest(input.targetUrl, input.workflow),
    targetUrl: input.targetUrl,
    workflow: validateForPublish(input.workflow),
    note: input.note,
    publishedAt: input.publishedAt,
  });
}

export function bindingOf(version: WorkflowVersion): VersionBinding {
  if (!verifyVersion(version)) throw new AppError("STORAGE_FAILED");
  return {
    versionId: version.id,
    version: version.version,
    digest: version.digest,
    targetUrl: version.targetUrl,
    workflow: version.workflow,
  };
}
