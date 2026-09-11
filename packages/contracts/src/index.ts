import { z } from "zod";

export const DEMO_URL = "clawler-demo://catalog/";
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
  if (url.href === DEMO_URL) return url.href;
  throw new AppError("FORBIDDEN");
}

export const profileSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(64),
  createdAt: z.string().datetime(),
});
export type Profile = z.infer<typeof profileSchema>;

const selectorSchema = z.string().trim().min(1).max(2048);
export const workflowActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("fill"),
    selector: selectorSchema,
    value: z.string().max(8000),
  }),
  z.strictObject({ kind: z.literal("click"), selector: selectorSchema }),
  z.strictObject({ kind: z.literal("wait"), selector: selectorSchema }),
]);
export const extractionSchema = z
  .strictObject({
    items: selectorSchema,
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
        }),
      )
      .min(1)
      .max(20),
  })
  .refine((value) => new Set(value.fields.map((field) => field.name)).size === value.fields.length);
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
  waitTimeoutMs: z.number().int().min(100).max(15_000),
  maxRecords: z.number().int().min(1).max(2000),
});
export type CollectionWorkflow = z.infer<typeof collectionWorkflowSchema>;
export type WorkflowAction = z.infer<typeof workflowActionSchema>;
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
});
export type AutomationInstance = z.infer<typeof automationInstanceSchema>;

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
export const stepKindSchema = z.enum(["navigate", "inspect", "fill", "click", "wait", "extract"]);
export const stepSchema = z.object({
  id: z.string(),
  kind: stepKindSchema,
  status: z.enum(["running", "succeeded", "failed", "cancelled"]),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
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
export const gatewayExecutionSchema = z.object({
  instance: automationInstanceSchema,
  scriptVersion: z.string().min(1),
  parameters: workflowParametersSchema.optional(),
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
});
export type StorageLocation = z.infer<typeof storageLocationSchema>;

export const requestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("workspace.get") }),
  z.object({ method: z.literal("storage.get") }),
  z.object({ method: z.literal("storage.choose") }),
  z.object({ method: z.literal("storage.open") }),
  z.object({ method: z.literal("storage.schedule"), path: z.string().trim().min(1).max(4096) }),
  z.object({ method: z.literal("storage.cancel") }),
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
  setBrowserBounds(bounds: BrowserBounds): Promise<void>;
  navigate(url: string): Promise<void>;
  startRecording(): Promise<void>;
  stopRecording(): Promise<Recording>;
  controlWindow(action: WindowControl): Promise<void>;
  startRun(instanceId: string, parameters?: Record<string, string>): Promise<Run>;
  cancelRun(id: string): Promise<void>;
  onRunChanged(listener: (run: Run) => void): () => void;
}

export { z };
