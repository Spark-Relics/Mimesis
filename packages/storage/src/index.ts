import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  AppError,
  automationInstanceSchema,
  DEMO_URL,
  draftSchema,
  profileSchema,
  runSchema,
  z,
} from "@clawler/contracts";

const legacyStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    profiles: z.array(profileSchema).min(1),
    selectedProfileId: z.string().uuid(),
    draft: draftSchema,
    runs: z.array(runSchema.omit({ instanceId: true })).max(50),
  })
  .refine((state) => state.profiles.some((profile) => profile.id === state.selectedProfileId));

const stateSchema = z
  .object({
    schemaVersion: z.literal(2),
    instances: z.array(automationInstanceSchema),
    profiles: z.array(profileSchema).min(1),
    selectedProfileId: z.string().uuid(),
    draft: draftSchema,
    runs: z.array(runSchema).max(50),
  })
  .refine((state) => state.profiles.some((profile) => profile.id === state.selectedProfileId))
  .refine((state) =>
    state.instances.every((instance) =>
      state.profiles.some((profile) => profile.id === instance.profileId),
    ),
  );

const unownedRunsStateSchema = z.object({
  schemaVersion: z.literal(2),
  instances: z.array(automationInstanceSchema).min(1),
  profiles: z.array(profileSchema).min(1),
  selectedProfileId: z.string().uuid(),
  draft: draftSchema,
  runs: z.array(runSchema.omit({ instanceId: true })).max(50),
});

export type StoredState = z.infer<typeof stateSchema>;

export interface WorkspaceRepository {
  load(): Promise<StoredState | undefined>;
  save(state: StoredState): Promise<void>;
}

/** Small local scaffold store. Serialize writes and atomically replace; never hide corrupt data. */
export class JsonWorkspaceRepository implements WorkspaceRepository {
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(): Promise<StoredState | undefined> {
    try {
      const input: unknown = JSON.parse(await readFile(this.file, "utf8"));
      const current = stateSchema.safeParse(input);
      if (current.success) return current.data;
      const legacy = legacyStateSchema.safeParse(input);
      if (legacy.success) {
        const now = new Date().toISOString();
        const instance = {
          id: crypto.randomUUID(),
          name: "Page inspector",
          scriptId: "page-inspector",
          profileId: legacy.data.selectedProfileId,
          targetUrl: DEMO_URL,
          enabled: true,
          createdAt: now,
          updatedAt: now,
        };
        return stateSchema.parse({
          ...legacy.data,
          schemaVersion: 2,
          instances: [instance],
          runs: legacy.data.runs.map((run) => ({ ...run, instanceId: instance.id })),
        });
      }
      const unownedRuns = unownedRunsStateSchema.safeParse(input);
      if (unownedRuns.success) {
        return stateSchema.parse({
          ...unownedRuns.data,
          runs: unownedRuns.data.runs.map((run) => {
            const matching = unownedRuns.data.instances.find(
              (instance) =>
                instance.scriptId === run.scriptId && instance.profileId === run.profileId,
            );
            const owner = matching ?? unownedRuns.data.instances[0];
            if (!owner) throw new AppError("STORAGE_FAILED");
            return { ...run, instanceId: owner.id };
          }),
        });
      }
      return stateSchema.parse(input);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return undefined;
      throw new AppError("STORAGE_FAILED", { cause: error });
    }
  }

  save(state: StoredState): Promise<void> {
    const content = JSON.stringify(stateSchema.parse(state), null, 2);
    const write = async () => {
      try {
        await mkdir(dirname(this.file), { recursive: true });
        const temporaryFile = `${this.file}.${crypto.randomUUID()}.tmp`;
        await writeFile(temporaryFile, content, "utf8");
        await rename(temporaryFile, this.file);
      } catch (error) {
        throw new AppError("STORAGE_FAILED", { cause: error });
      }
    };
    const next = this.writes.then(write);
    this.writes = next.catch(() => undefined);
    return next;
  }
}
