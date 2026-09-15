import { createHash } from "node:crypto";
import {
  AppError,
  type CollectionWorkflow,
  collectionWorkflowSchema,
  type VersionBinding,
  type WorkflowVersion,
  type WorkflowVersionExport,
  workflowVersionExportSchema,
  workflowVersionSchema,
} from "@clawler/contracts";

const placeholder = /\{\{([^{}]*)\}\}/gu;
/** Captured response bodies are referenced as `{{response:name}}`, never as run parameters. */
const responseRef = /^response:([a-zA-Z][a-zA-Z0-9_]{0,63})$/u;

/**
 * Parameter names referenced by a workflow, in first-use order.
 * `{{response:name}}` references resolve at runtime and are not inputs.
 */
export function parameterNames(workflow: CollectionWorkflow): string[] {
  const names: string[] = [];
  for (const action of workflow.before) {
    if (action.kind !== "fill") continue;
    for (const match of action.value.matchAll(placeholder)) {
      const name = match[1] ?? "";
      if (responseRef.test(name)) continue;
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(name)) throw new AppError("INVALID_INPUT");
      if (!names.includes(name)) names.push(name);
    }
    // A response reference must name something a preceding request captures.
    const captured = capturedNames(workflow, workflow.before.indexOf(action));
    for (const match of action.value.matchAll(placeholder)) {
      const ref = responseRef.exec(match[1] ?? "");
      if (ref && !captured.has(ref[1] ?? "")) throw new AppError("INVALID_INPUT");
    }
  }
  return names;
}

/** Capture names defined by request actions at or before `index` of `before`. */
function capturedNames(workflow: CollectionWorkflow, index: number): Set<string> {
  const names = new Set<string>();
  for (const action of workflow.before.slice(0, index + 1)) {
    if (action.kind === "request" && action.request.capture) names.add(action.request.capture.name);
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
    if (stripped.includes("{{") || stripped.includes("}}")) throw new AppError("INVALID_INPUT");
  }
  if (workflow.pagination && workflow.pagination.maxPages < 2) throw new AppError("INVALID_INPUT");
  for (const action of workflow.before) {
    if (action.kind !== "request") continue;
    // Duplicate capture names would silently overwrite earlier responses.
    const names = new Set<string>();
    for (const capture of [action.request.capture].flat()) {
      if (!capture) continue;
      if (names.has(capture.name)) throw new AppError("INVALID_INPUT");
      names.add(capture.name);
    }
  }
  return workflow;
}

/* Published content is identified by a digest over a canonical projection: object keys are
 * sorted so that key order in the stored JSON never changes the identity of a version. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => {
        if (left < right) return -1;
        if (left > right) return 1;
        return 0;
      });
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

/** Snapshot an execution may bind to. Stored content that no longer matches its digest is refused. */
export function bindingOf(version: WorkflowVersion): VersionBinding {
  if (!verifyVersion(version)) throw new AppError("VERSION_CONFLICT");
  return {
    versionId: version.id,
    version: version.version,
    digest: version.digest,
    targetUrl: version.targetUrl,
    workflow: version.workflow,
  };
}

/** Serialize one version into a portable, self-verifying file body. */
export function exportVersionFile(version: WorkflowVersion, exportedAt: string): string {
  if (!verifyVersion(version)) throw new AppError("VERSION_CONFLICT");
  const file: WorkflowVersionExport = {
    kind: "mimesis-version",
    exportVersion: 1,
    digest: version.digest,
    targetUrl: version.targetUrl,
    workflow: version.workflow,
    note: version.note,
    exportedAt,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * Import a portable version file into an instance: the file's digest must match its own content,
 * then the content is published as a fresh version number under the target instance.
 */
export function importVersionFile(
  content: string,
  input: { instanceId: string; existing: readonly WorkflowVersion[]; publishedAt: string },
): WorkflowVersion {
  let file: WorkflowVersionExport;
  try {
    file = workflowVersionExportSchema.parse(JSON.parse(content));
  } catch {
    throw new AppError("INVALID_INPUT");
  }
  if (file.digest !== workflowDigest(file.targetUrl, file.workflow))
    throw new AppError("VERSION_CONFLICT");
  const imported = buildVersion({
    instanceId: input.instanceId,
    targetUrl: file.targetUrl,
    workflow: file.workflow,
    note: file.note,
    publishedAt: input.publishedAt,
    existing: input.existing,
  });
  return imported;
}
