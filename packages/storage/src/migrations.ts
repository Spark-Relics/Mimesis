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

/** Historical formats are confined here; current services only see version 3. */
export function decodeState(input: unknown): StoredState {
  const version = z.object({ schemaVersion: z.number().int() }).parse(input).schemaVersion;
  if (version === 3) return stateSchema.parse(input);
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
  return stateSchema.parse({ ...legacy, schemaVersion: 3, instances, runs });
}
