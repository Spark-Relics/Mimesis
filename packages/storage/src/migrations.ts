import {
  AppError,
  automationInstanceSchema,
  DEMO_URL,
  profileSchema,
  runSchema,
  z,
} from "@clawler/contracts";
import { type StoredState, stateSchema } from "./state";

const legacySchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  profiles: z.array(profileSchema).min(1),
  selectedProfileId: z.string().uuid(),
  instances: z.array(automationInstanceSchema).optional(),
  runs: z.array(z.unknown()).max(50),
});

const versionThreeSchema = z.object({
  schemaVersion: z.literal(3),
  profiles: z.array(profileSchema).min(1),
  selectedProfileId: z.string().uuid(),
  instances: z.array(automationInstanceSchema),
  runs: z.array(runSchema).max(50),
});

/**
 * Historical formats are confined here; current services only see version 4.
 * Version 4 adds immutable published workflow versions, so every older workspace
 * starts with an empty version set and an unbound (never published) instance.
 */
export function decodeState(input: unknown): StoredState {
  const version = z.object({ schemaVersion: z.number().int() }).parse(input).schemaVersion;
  if (version === 4) return stateSchema.parse(input);
  if (version === 3) {
    const { instances, ...rest } = versionThreeSchema.parse(input);
    return stateSchema.parse({
      ...rest,
      schemaVersion: 4,
      instances: instances.map((instance) => ({ ...instance, publishedVersionId: null })),
      versions: [],
    });
  }
  const legacy = legacySchema.parse(input);
  let instances = legacy.instances;
  if (version === 1) {
    const now = new Date().toISOString();
    instances = [
      {
        id: crypto.randomUUID(),
        name: "Page inspector",
        scriptId: "page-inspector",
        profileId: legacy.selectedProfileId,
        targetUrl: DEMO_URL,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }
  if (!instances) throw new AppError("STORAGE_FAILED");
  const owners = instances;
  const runs = legacy.runs.map((inputRun) => {
    const record = z.record(z.string(), z.unknown()).parse(inputRun);
    if (Object.hasOwn(record, "instanceId")) return runSchema.parse(record);
    const run = runSchema.omit({ instanceId: true }).parse(record);
    const matching = owners.filter(
      (instance) => instance.scriptId === run.scriptId && instance.profileId === run.profileId,
    );
    if (matching.length !== 1) throw new AppError("STORAGE_FAILED");
    return runSchema.parse({ ...run, instanceId: matching[0]?.id });
  });
  return stateSchema.parse({
    profiles: legacy.profiles,
    selectedProfileId: legacy.selectedProfileId,
    schemaVersion: 4,
    instances: instances.map((instance) => ({ ...instance, publishedVersionId: null })),
    runs,
    versions: [],
  });
}
