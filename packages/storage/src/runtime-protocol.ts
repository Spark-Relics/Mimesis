import { gatewayStateSchema, z } from "@clawler/contracts";
import { stateSchema } from "./state";

export const artifactSchema = z.object({
  jobId: z.string().uuid(),
  path: z
    .string()
    .regex(
      /^instances\/[0-9a-f-]{36}\/jobs\/[0-9a-f-]{36}\/(?:job\.json|result\.(?:json|csv|ndjson))$/u,
    ),
  bytes: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});
export type Artifact = z.infer<typeof artifactSchema>;
export const runtimeCommandSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("initialize"),
    workspace: stateSchema.nullable(),
    gateway: gatewayStateSchema.nullable(),
    artifacts: z.array(artifactSchema).max(4000).optional(),
  }),
  z.object({ method: z.literal("initialized") }),
  z.object({ method: z.literal("workspace.load") }),
  z.object({ method: z.literal("workspace.save"), state: stateSchema }),
  z.object({ method: z.literal("gateway.load") }),
  z.object({
    method: z.literal("gateway.save"),
    state: gatewayStateSchema,
    artifacts: z.array(artifactSchema).max(4000),
  }),
  z.object({ method: z.literal("close") }),
]);
export type RuntimeCommand = z.infer<typeof runtimeCommandSchema>;
export const runtimeRequestSchema = z.object({
  id: z.number().int().positive(),
  command: runtimeCommandSchema,
});
export const runtimeResponseSchema = z.discriminatedUnion("ok", [
  z.object({ id: z.number().int().positive(), ok: z.literal(true), value: z.unknown() }),
  z.object({ id: z.number().int().positive(), ok: z.literal(false) }),
]);
