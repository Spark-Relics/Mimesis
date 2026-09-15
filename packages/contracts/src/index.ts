import { z } from "zod";

export const DEMO_URL = "clawler-demo://catalog/";
/** Local, app-served subtree that holds multi-page regression fixtures. */
export const DEMO_ROOT = "clawler-demo://catalog/";
export const DETAIL_DEMO_URL = "clawler-demo://catalog/detail/";
export const IPC = { request: "clawler:request", runChanged: "clawler:run-changed" } as const;

export const errorCodeSchema = z.enum([
  "INVALID_INPUT",
  "FORBIDDEN",
  "BUSY",
  "NOT_FOUND",
  "NAVIGATION_FAILED",
  "TIMEOUT",
  "CANCELLED",
  "STORAGE_FAILED",
  "INTERNAL",
  "DESKTOP_REQUIRED",
  "STORAGE_PATH_INVALID",
  "STORAGE_TARGET_OCCUPIED",
  "STORAGE_SPACE_LOW",
  "NO_PUBLISHED_VERSION",
  "VERSION_CONFLICT",
  "VERSION_LIMIT",
  "REQUEST_FAILED",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "AppError";
  }
}

export function toErrorCode(error: unknown): ErrorCode {
  if (error instanceof AppError) return error.code;
  if (error instanceof z.ZodError) return "INVALID_INPUT";
  return "INTERNAL";
}

export function validateNavigationUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("INVALID_INPUT");
  }
  if (url.username || url.password) throw new AppError("INVALID_INPUT");
  if (url.protocol === "http:" || url.protocol === "https:") return url.href;
  // The embedded fixture subtree is served locally by the host and never reaches the network.
  if (url.protocol === "clawler-demo:" && url.href.startsWith(DEMO_ROOT)) return url.href;
  throw new AppError("FORBIDDEN");
}

export const profileSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(64),
  createdAt: z.string().datetime(),
});
export type Profile = z.infer<typeof profileSchema>;

const selectorSchema = z.string().trim().min(1).max(2048);
/** Bounded precondition: the action runs only when the selector is present on the page. */
export const workflowConditionSchema = z.strictObject({ exists: selectorSchema });
/** `skip` records a failed best-effort action without aborting the run; the default is `fail`. */
export const actionErrorSchema = z.enum(["fail", "skip"]);
/** Bounded HTTP request action: parameters substitute `{{name}}` in url/headers/body. */
export const httpRequestSchema = z.strictObject({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
  url: z.string().trim().min(1).max(2048),
  headers: z.record(z.string().max(400), z.string().max(4000)).default({}),
  body: z.string().max(64_000).optional(),
  timeoutMs: z.number().int().min(100).max(30_000).default(10_000),
  /** Fail unless the response status equals this value. */
  expectStatus: z.number().int().min(100).max(599).default(200),
  /** Captured response body (bounded) is addressable later as `{{response:name}}`. */
  capture: z
    .strictObject({
      name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u),
      maxLength: z.number().int().min(1).max(64_000).default(64_000),
    })
    .optional(),
});
export const workflowActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("fill"),
    selector: selectorSchema,
    value: z.string().max(8000),
    when: workflowConditionSchema.optional(),
    onError: actionErrorSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("click"),
    selector: selectorSchema,
    when: workflowConditionSchema.optional(),
    onError: actionErrorSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("wait"),
    selector: selectorSchema,
    when: workflowConditionSchema.optional(),
    onError: actionErrorSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("request"),
    request: httpRequestSchema,
    when: workflowConditionSchema.optional(),
    onError: actionErrorSchema.optional(),
  }),
]);
export const extractionSchema = z
  .strictObject({
    items: selectorSchema,
    /** What happens when a row is missing a required field. Absent means "page": the whole extraction returns nothing. */
    missing: z.enum(["page", "row"]).optional(),
    fields: z
      .array(
        z.strictObject({
          name: z
            .string()
            .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u)
            .refine((name) => !["constructor", "prototype"].includes(name)),
          selector: z.string().trim().max(2048),
          attribute: z.enum(["text", "href", "src", "value"]),
          required: z.boolean(),
          /** Value normalization applied after extraction, before any expression. Absent means none. */
          normalize: z.enum(["none", "trim", "collapse", "upper", "lower"]).optional(),
          /** Restricted expression evaluated after extraction; overrides the selector value. */
          expression: z.string().max(1000).optional(),
        }),
      )
      .min(1)
      .max(20),
  })
  .refine((value) => new Set(value.fields.map((field) => field.name)).size === value.fields.length);
/** Optional nested traversal: open each list row's detail page, extract fields, then return to the list. */
export interface DetailTraversal {
  /** Selector resolved *within* a list item that opens its detail page. */
  link: string;
  /** Page-level extraction on the opened detail page; the first record is merged into the list row. */
  extract: Extraction;
  /** Control that returns to the list page. A real history entry is preferred when available. */
  back?: string | undefined;
  maxItems: number;
  /** Nested list living on the opened page; its rows become standalone records. */
  rows?: Extraction | undefined;
  /** Traversal applied to each nested row. Total nesting depth is capped at 3. */
  children?: DetailTraversal | undefined;
}
function traversalDepth(node: DetailTraversal): number {
  if (!node.children) return 1;
  return 1 + traversalDepth(node.children);
}
const detailNodeSchema: z.ZodType<DetailTraversal> = z.strictObject({
  link: selectorSchema,
  extract: z.lazy(() => extractionSchema),
  back: selectorSchema.optional(),
  maxItems: z.number().int().min(1).max(500),
  rows: z.lazy(() => extractionSchema).optional(),
  children: z.lazy(() => detailSchema).optional(),
});
export const detailSchema = detailNodeSchema.superRefine((node, issue) => {
  // The interpreter is recursive but bounded: deeper nesting is rejected at validation time.
  if (traversalDepth(node) > 3)
    issue.addIssue({ code: "custom", message: "traversal depth exceeds 3" });
});
export const collectionWorkflowSchema = z.strictObject({
  version: z.literal(1),
  before: z.array(workflowActionSchema).max(20),
  extract: extractionSchema,
  pagination: z
    .strictObject({
      next: selectorSchema,
      maxPages: z.number().int().min(1).max(50),
    })
    .nullable(),
  detail: detailSchema.optional(),
  waitTimeoutMs: z.number().int().min(100).max(15_000),
  maxRecords: z.number().int().min(1).max(2000),
  /**
   * Field names whose values form the deduplication key. Empty means the whole
   * record is the key. Publish validation requires every name to be an output field.
   */
  dedupe: z
    .array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u))
    .max(8)
    .default([]),
  /**
   * Optional record filter: a restricted expression evaluated against each
   * record before it enters the dataset; falsy results drop the record.
   * Referenced field names must be output fields (publish validation).
   */
  filter: z.string().max(1000).optional(),
});
export type CollectionWorkflow = z.infer<typeof collectionWorkflowSchema>;
/** Fixed input/output schema deterministically derived from an immutable workflow. */
export const workflowPlanSchema = z.strictObject({
  /** Input parameter names the workflow requires, in first-use order. */
  input: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u)).max(20),
  /** Output record fields in record order: list fields, then detail, then nested-row fields. */
  output: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u)).max(64),
  maxPages: z.number().int().min(1).max(50),
  maxRecords: z.number().int().min(1).max(2000),
  maxItemsPerPage: z.number().int().min(1).max(500),
});
export type WorkflowPlan = z.infer<typeof workflowPlanSchema>;
export type HttpRequestSpec = z.infer<typeof httpRequestSchema>;
export type WorkflowAction = z.infer<typeof workflowActionSchema>;
export type WorkflowCondition = z.infer<typeof workflowConditionSchema>;
export type ActionError = z.infer<typeof actionErrorSchema>;
export const recordingSchema = z.object({
  url: z.string(),
  actions: z.array(workflowActionSchema).max(20),
  skipped: z.number().int().min(0),
});
export type Recording = z.infer<typeof recordingSchema>;
export type Extraction = z.infer<typeof extractionSchema>;
export const workflowParametersSchema = z
  .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u), z.string().max(8000))
  .refine((params) => Object.keys(params).length <= 20);
export const collectionRecordsSchema = z
  .array(z.record(z.string(), z.string().max(16_000)))
  .max(2000);

export const automationInstanceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(64),
  scriptId: z.string().min(1).max(128),
  profileId: z.string().uuid(),
  targetUrl: z.string().min(1).max(4096),
  enabled: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  workflow: collectionWorkflowSchema.optional(),
  publishedVersionId: z.string().uuid().nullable().default(null),
});
export type AutomationInstance = z.infer<typeof automationInstanceSchema>;

/** Immutable published snapshot. Never edited in place; execution binds to it by id and digest. */
export const workflowVersionSchema = z.object({
  id: z.string().uuid(),
  instanceId: z.string().uuid(),
  version: z.number().int().min(1).max(1_000_000),
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
  targetUrl: z.string().min(1).max(4096),
  workflow: collectionWorkflowSchema,
  note: z.string().trim().max(200),
  publishedAt: z.string().datetime(),
});
export type WorkflowVersion = z.infer<typeof workflowVersionSchema>;

/** Portable single-version file. The digest lets importers reject tampered content up front. */
export const workflowVersionExportSchema = z.strictObject({
  kind: z.literal("mimesis-version"),
  exportVersion: z.literal(1),
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
  targetUrl: z.string().min(1).max(4096),
  workflow: collectionWorkflowSchema,
  note: z.string().trim().max(200),
  exportedAt: z.string().datetime(),
});
export type WorkflowVersionExport = z.infer<typeof workflowVersionExportSchema>;

export const instanceUpdateSchema = automationInstanceSchema.pick({
  name: true,
  profileId: true,
  targetUrl: true,
  enabled: true,
});

export type InstanceUpdate = z.infer<typeof instanceUpdateSchema>;

export const documentSchema = z.object({
  title: z.string(),
  url: z.string(),
  headings: z.array(z.string()),
  links: z.array(z.object({ text: z.string(), href: z.string() })),
  records: collectionRecordsSchema.optional(),
  collection: z
    .object({
      pages: z.number().int().min(1),
      stopReason: z.enum([
        "single-page",
        "next-unavailable",
        "no-new-records",
        "page-limit",
        "record-limit",
      ]),
      truncated: z.boolean(),
    })
    .optional(),
});
export type DocumentSnapshot = z.infer<typeof documentSchema>;

export const runStatusSchema = z.enum(["running", "succeeded", "failed", "cancelled"]);
export const stepKindSchema = z.enum([
  "navigate",
  "inspect",
  "fill",
  "click",
  "wait",
  "extract",
  "request",
]);
export const stepSchema = z.object({
  id: z.string(),
  kind: stepKindSchema,
  status: z.enum(["running", "succeeded", "failed", "cancelled", "skipped"]),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  /** Bounded, non-secret context such as the URL or selector the step acted on. */
  detail: z.string().max(300).default(""),
  /** Set only on the failing step, so a run is diagnosable without a separate log stream. */
  errorCode: errorCodeSchema.nullable().default(null),
});
export type StepKind = z.infer<typeof stepKindSchema>;
export type StepRecord = z.infer<typeof stepSchema>;
export const runSchema = z.object({
  id: z.string().uuid(),
  instanceId: z.string().uuid(),
  scriptId: z.string(),
  version: z.string(),
  profileId: z.string().uuid(),
  status: runStatusSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  steps: z.array(stepSchema),
  result: documentSchema.nullable(),
  errorCode: errorCodeSchema.nullable(),
  /** Published workflow version this run executed. Null only for runs recorded before version binding. */
  workflowVersionId: z.string().uuid().nullable().default(null),
});
export type Run = z.infer<typeof runSchema>;

export const gatewaySubmitSchema = z.strictObject({
  instanceId: z.string().uuid(),
  targetUrl: z.string().min(1).max(4096).optional(),
  parameters: workflowParametersSchema.optional(),
  cleaning: z
    .strictObject({
      trim: z.boolean().default(true),
      deduplicate: z.boolean().default(true),
    })
    .default({ trim: true, deduplicate: true }),
});
export type GatewaySubmission = z.infer<typeof gatewaySubmitSchema>;
/** Resolved immutable snapshot a job executes against. Absent only for jobs persisted before version binding existed. */
export const versionBindingSchema = z.object({
  versionId: z.string().uuid(),
  version: z.number().int().min(1),
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
  targetUrl: z.string().min(1).max(4096),
  workflow: collectionWorkflowSchema,
});
export type VersionBinding = z.infer<typeof versionBindingSchema>;
export const gatewayExecutionSchema = z.object({
  instance: automationInstanceSchema,
  scriptVersion: z.string().min(1),
  parameters: workflowParametersSchema.optional(),
  binding: versionBindingSchema.nullable().default(null),
});
export type GatewayExecution = z.infer<typeof gatewayExecutionSchema>;
export const gatewayJobSchema = z.object({
  id: z.string().uuid(),
  idempotencyKey: z.string().min(1).max(128).nullable(),
  submission: gatewaySubmitSchema,
  execution: gatewayExecutionSchema,
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  errorCode: z.union([errorCodeSchema, z.literal("INTERRUPTED")]).nullable(),
  cancelRequested: z.boolean().default(false),
  run: runSchema.nullable(),
});
export type GatewayJob = z.infer<typeof gatewayJobSchema>;
export const gatewayStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobs: z.array(gatewayJobSchema),
  })
  .superRefine((state, context) => {
    const ids = new Set<string>();
    const keys = new Set<string>();
    for (const job of state.jobs) {
      if (ids.has(job.id) || (job.idempotencyKey !== null && keys.has(job.idempotencyKey)))
        context.addIssue({ code: "custom", message: "Duplicate job or idempotency key" });
      ids.add(job.id);
      if (job.idempotencyKey !== null) keys.add(job.idempotencyKey);
      if (job.submission.instanceId !== job.execution.instance.id)
        context.addIssue({ code: "custom", message: "Job instance mismatch" });
    }
  });
export type GatewayState = z.infer<typeof gatewayStateSchema>;

export const scriptManifestSchema = z.object({
  id: z.string(),
  version: z.string(),
  sdkVersion: z.literal(1),
  ai: z.literal("disabled"),
  implementation: z.literal("bundled"),
});
export type ScriptManifest = z.infer<typeof scriptManifestSchema>;
export const workspaceSchema = z.object({
  instances: z.array(automationInstanceSchema),
  profiles: z.array(profileSchema).min(1),
  selectedProfileId: z.string().uuid(),
  runs: z.array(runSchema),
  versions: z.array(workflowVersionSchema),
  scripts: z.array(scriptManifestSchema),
});
export type WorkspaceSnapshot = z.infer<typeof workspaceSchema>;

export const boundsSchema = z.object({
  x: z.number().finite().min(0).max(20_000),
  y: z.number().finite().min(0).max(20_000),
  width: z.number().finite().min(0).max(20_000),
  height: z.number().finite().min(0).max(20_000),
  visible: z.boolean(),
});
export type BrowserBounds = z.infer<typeof boundsSchema>;
export const windowControlSchema = z.enum(["minimize", "toggle-maximize", "close"]);
export type WindowControl = z.infer<typeof windowControlSchema>;

export const storageLocationSchema = z.object({
  current: z.string(),
  source: z.enum(["default", "configuration", "environment"]),
  pending: z.string().nullable(),
  pendingBackup: z.string().nullable(),
  pendingBackupKind: z.enum(["backup", "restore"]).nullable(),
});
export type StorageLocation = z.infer<typeof storageLocationSchema>;

export const requestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("workspace.get") }),
  z.object({ method: z.literal("storage.get") }),
  z.object({ method: z.literal("storage.choose") }),
  z.object({ method: z.literal("storage.open") }),
  z.object({ method: z.literal("storage.schedule"), path: z.string().trim().min(1).max(4096) }),
  z.object({ method: z.literal("storage.cancel") }),
  z.object({
    method: z.literal("storage.backup.schedule"),
    kind: z.enum(["backup", "restore"]),
    path: z.string().trim().min(1).max(4096),
  }),
  z.object({ method: z.literal("storage.backup.cancel") }),
  z.object({ method: z.literal("profiles.create"), name: z.string().trim().min(1).max(64) }),
  z.object({ method: z.literal("profiles.select"), id: z.string().uuid() }),
  z.object({ method: z.literal("instances.create"), name: z.string().trim().min(1).max(64) }),
  z.object({
    method: z.literal("workflow.save"),
    instanceId: z.string().uuid(),
    workflow: collectionWorkflowSchema,
    input: instanceUpdateSchema.optional(),
  }),
  z.object({
    method: z.literal("instances.update"),
    id: z.string().uuid(),
    input: instanceUpdateSchema,
  }),
  z.object({
    method: z.literal("versions.publish"),
    instanceId: z.string().uuid(),
    note: z.string().trim().max(200).optional(),
  }),
  z.object({
    method: z.literal("versions.rollback"),
    instanceId: z.string().uuid(),
    versionId: z.string().uuid(),
  }),
  z.object({ method: z.literal("versions.export"), versionId: z.string().uuid() }),
  z.object({ method: z.literal("versions.import"), instanceId: z.string().uuid() }),
  z.object({
    method: z.literal("workflow.plan"),
    workflow: collectionWorkflowSchema,
  }),

  z.object({ method: z.literal("browser.bounds"), bounds: boundsSchema }),
  z.object({ method: z.literal("browser.navigate"), url: z.string().min(1).max(4096) }),
  z.object({ method: z.literal("recording.start") }),
  z.object({ method: z.literal("recording.stop") }),
  z.object({ method: z.literal("window.control"), action: windowControlSchema }),
  z.object({
    method: z.literal("runs.start"),
    instanceId: z.string().uuid(),
    parameters: workflowParametersSchema.optional(),
  }),
  z.object({
    method: z.literal("runs.dry"),
    instanceId: z.string().uuid(),
    workflow: collectionWorkflowSchema,
    parameters: workflowParametersSchema.optional(),
  }),
  z.object({ method: z.literal("runs.cancel"), id: z.string().uuid() }),
]);
export type DesktopRequest = z.infer<typeof requestSchema>;
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: ErrorCode };

export interface DesktopBridge {
  getStorageLocation(): Promise<StorageLocation>;
  chooseStorageDirectory(): Promise<string | null>;
  openStorageDirectory(): Promise<void>;
  scheduleStorageDirectory(path: string): Promise<StorageLocation>;
  cancelStorageDirectory(): Promise<StorageLocation>;
  scheduleStorageBackup(kind: "backup" | "restore", path: string): Promise<StorageLocation>;
  cancelStorageBackup(): Promise<StorageLocation>;
  getWorkspace(): Promise<WorkspaceSnapshot>;
  createProfile(name: string): Promise<Profile>;
  selectProfile(id: string): Promise<void>;
  createInstance(name: string): Promise<AutomationInstance>;
  updateInstance(id: string, input: InstanceUpdate): Promise<AutomationInstance>;
  saveWorkflow(
    instanceId: string,
    workflow: CollectionWorkflow,
    input?: InstanceUpdate,
  ): Promise<AutomationInstance>;
  publishWorkflow(instanceId: string, note?: string): Promise<WorkflowVersion>;
  rollbackWorkflow(instanceId: string, versionId: string): Promise<AutomationInstance>;
  exportVersion(versionId: string): Promise<string | null>;
  importVersion(instanceId: string): Promise<WorkflowVersion>;
  planWorkflow(workflow: CollectionWorkflow): Promise<WorkflowPlan>;

  setBrowserBounds(bounds: BrowserBounds): Promise<void>;
  navigate(url: string): Promise<void>;
  startRecording(): Promise<void>;
  stopRecording(): Promise<Recording>;
  controlWindow(action: WindowControl): Promise<void>;
  startRun(instanceId: string, parameters?: Record<string, string>): Promise<Run>;
  /** Bounded single-page dry run of a draft workflow. Never persisted to run history. */
  dryRun(
    instanceId: string,
    workflow: CollectionWorkflow,
    parameters?: Record<string, string>,
  ): Promise<Run>;
  cancelRun(id: string): Promise<void>;
  onRunChanged(listener: (run: Run) => void): () => void;
}

export { z };
