import {
  automationInstanceSchema,
  profileSchema,
  runSchema,
  workflowVersionSchema,
  z,
} from "@clawler/contracts";

export const stateSchema = z
  .object({
    schemaVersion: z.literal(5),
    instances: z.array(automationInstanceSchema),
    profiles: z.array(profileSchema).min(1),
    selectedProfileId: z.string().uuid(),
    runs: z.array(runSchema).max(50),
    versions: z.array(workflowVersionSchema).max(500),
  })
  .refine(
    (state) =>
      new Set(state.profiles.map((entry) => entry.id)).size === state.profiles.length &&
      new Set(state.instances.map((entry) => entry.id)).size === state.instances.length &&
      new Set(state.runs.map((entry) => entry.id)).size === state.runs.length &&
      new Set(state.versions.map((entry) => entry.id)).size === state.versions.length,
  )
  .refine((state) => state.profiles.some((profile) => profile.id === state.selectedProfileId))
  .refine((state) =>
    state.instances.every((instance) =>
      state.profiles.some((profile) => profile.id === instance.profileId),
    ),
  )
  .refine((state) =>
    state.versions.every((version) =>
      state.instances.some((instance) => instance.id === version.instanceId),
    ),
  )
  .refine((state) =>
    state.instances.every((instance) => {
      if (instance.publishedVersionId === null) return true;
      return state.versions.some(
        (entry) => entry.id === instance.publishedVersionId && entry.instanceId === instance.id,
      );
    }),
  );

export type StoredState = z.infer<typeof stateSchema>;
