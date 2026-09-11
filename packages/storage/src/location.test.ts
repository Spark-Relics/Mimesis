import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { StorageLocationManager } from "./location";
import { migrateDirectory } from "./location-migration";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    statfsSync: vi.fn(actual.statfsSync),
    copyFileSync: vi.fn(actual.copyFileSync),
  };
});

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "mimesis-location-"));
  const configuration = join(root, "launcher");
  const source = join(root, "source");
  const target = join(root, "自定义 data");
  fs.mkdirSync(configuration);
  fs.mkdirSync(source);
  fs.mkdirSync(join(source, "runtime"));
  fs.writeFileSync(join(source, "runtime", "test.json"), '{"title":"中文"}');
  return { root, configuration, source, target };
}

it("schedules, cancels, then migrates all files on startup and preserves originals", async () => {
  const { configuration, source, target } = fixture();
  let manager = new StorageLocationManager(configuration, source);
  try {
    expect((await manager.schedule(target)).pending).toBe(target);
    expect(fs.existsSync(target)).toBe(false);
    expect((await manager.cancel()).pending).toBeNull();
    await manager.schedule(target);
  } finally {
    manager.close();
  }
  manager = new StorageLocationManager(configuration, source);
  try {
    expect(manager.info()).toEqual({ current: target, source: "configuration", pending: null });
    expect(fs.readFileSync(join(target, "runtime", "test.json"), "utf8")).toBe(
      fs.readFileSync(join(source, "runtime", "test.json"), "utf8"),
    );
    fs.writeFileSync(join(target, "new.txt"), "new workspace state");
  } finally {
    manager.close();
  }
  manager = new StorageLocationManager(configuration, source);
  expect(manager.current).toBe(target);
  manager.close();
});

it("protects active roots and rejects invalid, nested, occupied and linked destinations", async () => {
  const { root, configuration, source, target } = fixture();
  const manager = new StorageLocationManager(configuration, source);
  try {
    expect(() => new StorageLocationManager(configuration, source)).toThrow("BUSY");
    for (const path of [
      "relative/path",
      source,
      root,
      join(source, "child"),
      configuration,
      join(root, "absent-parent", "data"),
    ])
      await expect(manager.schedule(path)).rejects.toThrow("STORAGE_PATH_INVALID");
    fs.mkdirSync(target);
    fs.writeFileSync(join(target, "user-file"), "keep");
    await expect(manager.schedule(target)).rejects.toThrow("STORAGE_TARGET_OCCUPIED");
    const junction = join(root, "link");
    fs.symlinkSync(target, junction, "junction");
    await expect(manager.schedule(junction)).rejects.toThrow("STORAGE_PATH_INVALID");
    expect(fs.readFileSync(join(target, "user-file"), "utf8")).toBe("keep");
  } finally {
    manager.close();
  }
});

it("honors explicit environment overrides without erasing configured or pending locations", async () => {
  const { root, configuration, source, target } = fixture();
  const manager = new StorageLocationManager(configuration, source);
  await manager.schedule(target);
  manager.close();
  const override = new StorageLocationManager(configuration, source, join(root, "override"));
  try {
    expect(override.info().source).toBe("environment");
    expect(override.info().pending).toBeNull();
    await expect(override.schedule(target)).rejects.toThrow("FORBIDDEN");
    expect(
      JSON.parse(fs.readFileSync(join(configuration, "launcher.json"), "utf8")).pending.target,
    ).toBe(target);
  } finally {
    override.close();
  }
});

it("fails closed if a scheduled target becomes occupied and allows cancelling recovery", async () => {
  const { configuration, source, target } = fixture();
  const manager = new StorageLocationManager(configuration, source);
  await manager.schedule(target);
  manager.close();
  fs.mkdirSync(target);
  fs.writeFileSync(join(target, "keep"), "user content");
  expect(() => new StorageLocationManager(configuration, source)).toThrow(
    "STORAGE_TARGET_OCCUPIED",
  );
  expect(fs.existsSync(join(source, "runtime", "test.json"))).toBe(true);
  StorageLocationManager.cancelPending(configuration);
  const recovered = new StorageLocationManager(configuration, source);
  expect(recovered.current).toBe(source);
  recovered.close();
  expect(fs.readFileSync(join(target, "keep"), "utf8")).toBe("user content");
});

it("resumes after a promoted copy but an uncommitted launcher update, rejecting tampered copies", async () => {
  const { configuration, source, target } = fixture();
  const manager = new StorageLocationManager(configuration, source);
  await manager.schedule(target);
  manager.close();
  const config = JSON.parse(fs.readFileSync(join(configuration, "launcher.json"), "utf8"));
  migrateDirectory(config.pending, configuration);
  fs.writeFileSync(join(target, "runtime", "test.json"), "tampered");
  expect(() => new StorageLocationManager(configuration, source)).toThrow("STORAGE_FAILED");
  fs.copyFileSync(join(source, "runtime", "test.json"), join(target, "runtime", "test.json"));
  const recovered = new StorageLocationManager(configuration, source);
  expect(recovered.current).toBe(target);
  recovered.close();
});

it("retains pending and source data on insufficient space", async () => {
  const { configuration, source, target } = fixture();
  const manager = new StorageLocationManager(configuration, source);
  await manager.schedule(target);
  manager.close();
  const original = fs.statfsSync(source);
  vi.mocked(fs.statfsSync).mockReturnValueOnce({ ...original, bavail: 0 });
  expect(() => new StorageLocationManager(configuration, source)).toThrow("STORAGE_SPACE_LOW");
  expect(
    JSON.parse(fs.readFileSync(join(configuration, "launcher.json"), "utf8")).pending.target,
  ).toBe(target);
  const recovered = new StorageLocationManager(configuration, source);
  recovered.close();
});

it("recovers a partial copy after a real file write failure without deleting source files", async () => {
  const { configuration, source, target } = fixture();
  fs.writeFileSync(join(source, "z-last.txt"), "last file");
  const manager = new StorageLocationManager(configuration, source);
  await manager.schedule(target);
  manager.close();
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(fs.copyFileSync)
    .mockImplementationOnce(actual.copyFileSync)
    .mockImplementationOnce(() => {
      throw Object.assign(new Error("injected failure"), { code: "ENOSPC" });
    });
  expect(() => new StorageLocationManager(configuration, source)).toThrow("injected failure");
  expect(fs.existsSync(target)).toBe(false);
  expect(fs.readFileSync(join(source, "z-last.txt"), "utf8")).toBe("last file");
  const recovered = new StorageLocationManager(configuration, source);
  expect(fs.readFileSync(join(target, "z-last.txt"), "utf8")).toBe("last file");
  recovered.close();
});

it("waits for configuration writes before exit and keeps failed saves out of memory", async () => {
  const { configuration, source, target } = fixture();
  const manager = new StorageLocationManager(configuration, source);
  const file = join(configuration, "launcher.json");
  fs.mkdirSync(file);
  await expect(manager.schedule(target)).rejects.toThrow("STORAGE_FAILED");
  await expect(manager.flush()).rejects.toThrow();
  expect(manager.info().pending).toBeNull();
  fs.rmdirSync(file);
  const saving = manager.schedule(target);
  await manager.flush();
  expect(JSON.parse(fs.readFileSync(file, "utf8")).pending.target).toBe(target);
  await saving;
  expect(StorageLocationManager.hasPending(configuration)).toBe(true);
  manager.close();
});

it("never silently creates an empty workspace for missing custom roots or corrupt configuration", () => {
  const { configuration, source, target } = fixture();
  const file = join(configuration, "launcher.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, directory: target, pending: null }));
  expect(() => new StorageLocationManager(configuration, source)).toThrow("STORAGE_PATH_INVALID");
  expect(fs.existsSync(target)).toBe(false);
  for (const content of [
    "broken",
    JSON.stringify({ version: 99, directory: source, pending: null }),
  ]) {
    fs.writeFileSync(file, content);
    expect(() => new StorageLocationManager(configuration, source)).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(content);
    expect(StorageLocationManager.hasPending(configuration)).toBe(false);
  }
});
