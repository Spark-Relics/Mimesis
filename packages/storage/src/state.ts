import { automationInstanceSchema, profileSchema, runSchema, z } from "@clawler/contracts";

export const stateSchema = z
  .object({
    schemaVersion: z.literal(3),
    instances: z.array(automationInstanceSchema),
    profiles: z.array(profileSchema).min(1),
    selectedProfileId: z.string().uuid(),
    runs: z.array(runSchema).max(50),
  })
  .refine(
    (state) =>
      new Set(state.profiles.map((entry) => entry.id)).size === state.profiles.length &&
      new Set(state.instances.map((entry) => entry.id)).size === state.instances.length &&
      new Set(state.runs.map((entry) => entry.id)).size === state.runs.length,
  )
  .refine((state) => state.profiles.some((profile) => profile.id === state.selectedProfileId))
  .refine((state) =>
    state.instances.every((instance) =>
      state.profiles.some((profile) => profile.id === instance.profileId),
    ),
  );

export type StoredState = z.infer<typeof stateSchema>;
