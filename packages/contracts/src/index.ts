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

export const automationInstanceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(64),
  scriptId: z.string().min(1).max(128),
  profileId: z.string().uuid(),
  targetUrl: z.string().min(1).max(4096),
  enabled: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
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
});
export type DocumentSnapshot = z.infer<typeof documentSchema>;

export const runStatusSchema = z.enum(["running", "succeeded", "failed", "cancelled"]);
export const stepKindSchema = z.enum(["navigate", "inspect"]);
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
  cleaning: z.strictObject({
    trim: z.boolean().default(true),
    deduplicate: z.boolean().default(true),
  }).default({ trim: true, deduplicate: true }),
});
export type GatewaySubmission = z.infer<typeof gatewaySubmitSchema>;
export const gatewayExecutionSchema = z.object({
  instance: automationInstanceSchema,
  scriptVersion: z.string().min(1),
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
export const gatewayStateSchema = z.object({
  schemaVersion: z.literal(1),
  jobs: z.array(gatewayJobSchema),
}).superRefine((state, context) => {
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
export const draftSchema = z.object({
  source: z.string().max(100_000),
  updatedAt: z.string().datetime(),
});
export type ScriptDraft = z.infer<typeof draftSchema>;

export const workspaceSchema = z.object({
  instances: z.array(automationInstanceSchema),
  profiles: z.array(profileSchema).min(1),
  selectedProfileId: z.string().uuid(),
  draft: draftSchema,
  runs: z.array(runSchema),
  scripts: z.array(scriptManifestSchema),
  publishedSource: z.string(),
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

export const requestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("workspace.get") }),
  z.object({ method: z.literal("draft.save"), source: z.string().max(100_000) }),
  z.object({ method: z.literal("profiles.create"), name: z.string().trim().min(1).max(64) }),
  z.object({ method: z.literal("profiles.select"), id: z.string().uuid() }),
  z.object({ method: z.literal("instances.create"), name: z.string().trim().min(1).max(64) }),
  z.object({
    method: z.literal("instances.update"),
    id: z.string().uuid(),
    input: instanceUpdateSchema,
  }),
  z.object({ method: z.literal("browser.bounds"), bounds: boundsSchema }),
  z.object({ method: z.literal("browser.navigate"), url: z.string().min(1).max(4096) }),
  z.object({ method: z.literal("window.control"), action: windowControlSchema }),
  z.object({
    method: z.literal("runs.start"),
    instanceId: z.string().uuid(),
  }),
  z.object({ method: z.literal("runs.cancel"), id: z.string().uuid() }),
]);
export type DesktopRequest = z.infer<typeof requestSchema>;
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: ErrorCode };

export interface DesktopBridge {
  getWorkspace(): Promise<WorkspaceSnapshot>;
  saveDraft(source: string): Promise<ScriptDraft>;
  createProfile(name: string): Promise<Profile>;
  selectProfile(id: string): Promise<void>;
  createInstance(name: string): Promise<AutomationInstance>;
  updateInstance(id: string, input: InstanceUpdate): Promise<AutomationInstance>;
  setBrowserBounds(bounds: BrowserBounds): Promise<void>;
  navigate(url: string): Promise<void>;
  controlWindow(action: WindowControl): Promise<void>;
  startRun(instanceId: string): Promise<Run>;
  cancelRun(id: string): Promise<void>;
  onRunChanged(listener: (run: Run) => void): () => void;
}

export { z };
