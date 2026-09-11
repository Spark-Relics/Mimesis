import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { atomicWrite } from "./atomic-file";
import type { StoredState } from "./index";
import { legacySnapshot } from "./legacy-import";

const profile = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Test",
  createdAt: "2026-09-06T00:00:00.000Z",
};
const initial: StoredState = {
  schemaVersion: 3,
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
  runs: [],
};

it("backs up legacy source and preserves workflows while removing the obsolete live draft", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "clawler-store-")), "workspace.json");
  const expected: StoredState = {
    ...initial,
    instances: initial.instances.map((instance) => ({
      ...instance,
      scriptId: "collection-workflow",
      workflow: {
        version: 1,
        before: [],
        extract: {
          items: ".row",
          fields: [{ name: "title", selector: ".title", attribute: "text", required: true }],
        },
        pagination: { next: ".next", maxPages: 3 },
        waitTimeoutMs: 5000,
        maxRecords: 200,
      },
    })),
  };
  const original = JSON.stringify({
    ...expected,
    schemaVersion: 2,
    draft: { source: "unpublished legacy content", updatedAt: profile.createdAt },
  });
  await writeFile(path, original);
  const repository = { load: () => loadLegacy(path) };
  const migrated = await repository.load();
  expect(migrated).toEqual(expected);
  expect(await readFile(`${path}.pre-sqlite.backup.json`, "utf8")).toBe(original);
  expect(await repository.load()).toEqual(expected);
  if (!migrated) throw new Error("Missing migration");
  expect(await readFile(path, "utf8")).toBe(original);
  expect(await readFile(`${path}.pre-sqlite.backup.json`, "utf8")).toBe(original);
});

it("refuses unknown future formats and never overwrites a conflicting migration backup", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "clawler-store-")), "workspace.json");
  const repository = { load: () => loadLegacy(path) };
  await writeFile(path, JSON.stringify({ ...initial, schemaVersion: 4 }));
  await expect(repository.load()).rejects.toThrow();
  const original = JSON.stringify({ ...initial, schemaVersion: 2 });
  await writeFile(path, original);
  await writeFile(`${path}.pre-sqlite.backup.json`, "different backup");
  await expect(repository.load()).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe(original);
  expect(await readFile(`${path}.pre-sqlite.backup.json`, "utf8")).toBe("different backup");
});

it("rejects malformed ownership rather than reassigning a historical run", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "clawler-store-")), "workspace.json");
  const run = {
    id: crypto.randomUUID(),
    instanceId: "invalid",
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
  await writeFile(path, JSON.stringify({ ...initial, schemaVersion: 2, runs: [run] }));
  await expect(loadLegacy(path)).rejects.toThrow();
});

it("cleans temporary files when replacing the destination fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "clawler-atomic-"));
  const destination = join(root, "directory");
  await mkdir(destination);
  await writeFile(join(destination, "keep"), "original");
  await expect(atomicWrite(destination, "replacement")).rejects.toThrow();
  expect(await readdir(root)).toEqual(["directory"]);
  expect(await readFile(join(destination, "keep"), "utf8")).toBe("original");
});

it("reports corrupt state without silently overwriting it", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "clawler-store-")), "workspace.json");
  await writeFile(path, "broken", "utf8");
  const repository = { load: () => loadLegacy(path) };
  await expect(repository.load()).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe("broken");
});

it("migrates a version 1 workspace into an instance-owned workspace", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "clawler-store-")), "workspace.json");
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      profiles: [profile],
      selectedProfileId: profile.id,
      draft: { source: "old draft", updatedAt: profile.createdAt },
      runs: [],
    }),
    "utf8",
  );
  const migrated = await loadLegacy(path);
  expect(migrated?.schemaVersion).toBe(3);
  expect(migrated?.instances).toHaveLength(1);
  expect(migrated?.instances[0]?.profileId).toBe(profile.id);
});

it("repairs transition data whose runs predate instance ownership", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "clawler-store-")), "workspace.json");
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
  await writeFile(
    path,
    JSON.stringify({ ...initial, schemaVersion: 2, runs: [legacyRun] }),
    "utf8",
  );
  const migrated = await loadLegacy(path);
  expect(migrated?.runs[0]?.instanceId).toBe(initial.instances[0]?.id);
});

it("preserves explicit run ownership when two instances share one script and profile", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "clawler-store-")), "workspace.json");
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
  const repository = { load: () => loadLegacy(path) };
  await writeFile(path, JSON.stringify(state));
  expect((await repository.load())?.runs[0]?.instanceId).toBe(second.id);
});

async function loadLegacy(path: string) {
  return (await legacySnapshot(dirname(path))).workspace;
}
