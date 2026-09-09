import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { JsonWorkspaceRepository, type StoredState } from "./index";

const profile = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Test",
  createdAt: "2026-09-06T00:00:00.000Z",
};
const initial: StoredState = {
  schemaVersion: 2,
  instances: [
    {
      id: "00000000-0000-4000-8000-000000000002",
      name: "Test instance",
      scriptId: "page-inspector",
      profileId: profile.id,
      targetUrl: "https://example.com/",
      enabled: true,
      createdAt: profile.createdAt,
      updatedAt: profile.createdAt,
    },
  ],
  profiles: [profile],
  selectedProfileId: profile.id,
  draft: { source: "initial", updatedAt: profile.createdAt },
  runs: [],
};

it("serializes writes and preserves the latest draft on disk", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "clawler-store-")), "state.json");
  const repository = new JsonWorkspaceRepository(path);
  expect(await repository.load()).toBeUndefined();
  await Promise.all([
    repository.save(initial),
    repository.save({ ...initial, draft: { ...initial.draft, source: "updated" } }),
  ]);
  expect((await repository.load())?.draft.source).toBe("updated");
});

it("reports corrupt state without silently overwriting it", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "clawler-store-")), "state.json");
  await writeFile(path, "broken", "utf8");
  const repository = new JsonWorkspaceRepository(path);
  await expect(repository.load()).rejects.toThrow("STORAGE_FAILED");
  expect(await readFile(path, "utf8")).toBe("broken");
});

it("migrates a version 1 workspace into an instance-owned workspace", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "clawler-store-")), "state.json");
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      profiles: [profile],
      selectedProfileId: profile.id,
      draft: initial.draft,
      runs: [],
    }),
    "utf8",
  );
  const migrated = await new JsonWorkspaceRepository(path).load();
  expect(migrated?.schemaVersion).toBe(2);
  expect(migrated?.instances).toHaveLength(1);
  expect(migrated?.instances[0]?.profileId).toBe(profile.id);
});

it("repairs transition data whose runs predate instance ownership", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "clawler-store-")), "state.json");
  const legacyRun = {
    id: "00000000-0000-4000-8000-000000000003",
    scriptId: "page-inspector",
    version: "1.0.0",
    profileId: profile.id,
    status: "succeeded",
    startedAt: profile.createdAt,
    finishedAt: profile.createdAt,
    steps: [],
    result: null,
    errorCode: null,
  };
  await writeFile(path, JSON.stringify({ ...initial, runs: [legacyRun] }), "utf8");
  const migrated = await new JsonWorkspaceRepository(path).load();
  expect(migrated?.runs[0]?.instanceId).toBe(initial.instances[0]?.id);
});

it("preserves explicit run ownership when two instances share one script and profile", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "clawler-store-")), "state.json");
  const first = initial.instances[0];
  if (!first) throw new Error("Missing instance");
  const second = { ...first, id: crypto.randomUUID(), name: "Second instance" };
  const state: StoredState = {
    ...initial,
    instances: [first, second],
    runs: [
      {
        id: crypto.randomUUID(),
        instanceId: second.id,
        scriptId: first.scriptId,
        version: "1.0.0",
        profileId: profile.id,
        status: "succeeded",
        startedAt: profile.createdAt,
        finishedAt: profile.createdAt,
        steps: [],
        result: null,
        errorCode: null,
      },
    ],
  };
  const repository = new JsonWorkspaceRepository(path);
  await repository.save(state);
  expect((await repository.load())?.runs[0]?.instanceId).toBe(second.id);
});
