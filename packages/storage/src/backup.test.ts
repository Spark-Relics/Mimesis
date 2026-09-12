import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createBackup, readBackupMarker, restoreBackup } from "./backup";
import { StorageLocationManager } from "./location";

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "mimesis-backup-"));
  const configuration = join(root, "launcher");
  const source = join(root, "live");
  const backupTarget = join(root, "备份 目标");
  fs.mkdirSync(configuration);
  fs.mkdirSync(join(source, "runtime"), { recursive: true });
  fs.writeFileSync(join(source, "runtime", "runtime.sqlite"), "sqlite-bytes-中文");
  fs.writeFileSync(join(source, "runtime", "notes.txt"), "line1\nline2\n");
  return { root, configuration, source, backupTarget };
}

it("creates a verified backup on next launch without touching the live root", async () => {
  const { configuration, source, backupTarget } = fixture();
  let manager = new StorageLocationManager(configuration, source);
  try {
    const info = await manager.scheduleBackup({ kind: "backup", path: backupTarget });
    expect(info.pendingBackup).toBe(backupTarget);
    expect(info.pendingBackupKind).toBe("backup");
    expect(fs.existsSync(backupTarget)).toBe(false);
    // Live root keeps working while a plan is pending.
    fs.writeFileSync(join(source, "runtime", "runtime.sqlite"), "sqlite-bytes-中文-v2");
  } finally {
    manager.close();
  }
  // Mutations after scheduling are included: the transfer runs on next launch.
  manager = new StorageLocationManager(configuration, source);
  try {
    expect(manager.info().pendingBackup).toBeNull();
    expect(fs.readFileSync(join(backupTarget, "runtime", "runtime.sqlite"), "utf8")).toBe(
      "sqlite-bytes-中文-v2",
    );
    const receipt = readBackupMarker(backupTarget);
    expect(receipt.complete).toBe(true);
    expect(receipt.plan.kind).toBe("backup");
    // Source untouched.
    expect(fs.existsSync(join(source, "runtime", "notes.txt"))).toBe(true);
  } finally {
    manager.close();
  }
});

it("restores from a verified backup into a fresh directory and switches on next launch", async () => {
  const { configuration, source, backupTarget } = fixture();
  let manager = new StorageLocationManager(configuration, source);
  try {
    await manager.scheduleBackup({ kind: "backup", path: backupTarget });
  } finally {
    manager.close();
  }
  manager = new StorageLocationManager(configuration, source);
  try {
    // The backup is now complete; damage the live root after taking it.
    fs.writeFileSync(join(source, "runtime", "notes.txt"), "corrupted");
    const restoredRoot = fs
      .readdirSync(join(source, ".."))
      .find((name) => name.startsWith("mimesis-restored-"));
    expect(restoredRoot).toBeUndefined();
    const info = await manager.scheduleBackup({ kind: "restore", path: backupTarget });
    expect(info.pendingBackupKind).toBe("restore");
    expect(fs.existsSync(join(source, "runtime", "notes.txt"))).toBe(true);
  } finally {
    manager.close();
  }
  manager = new StorageLocationManager(configuration, source);
  try {
    expect(manager.info().source).toBe("configuration");
    expect(fs.readFileSync(join(manager.current, "runtime", "notes.txt"), "utf8")).toBe(
      "line1\nline2\n",
    );
    // The damaged previous root is preserved, never deleted.
    expect(fs.readFileSync(join(source, "runtime", "notes.txt"), "utf8")).toBe("corrupted");
    expect(readBackupMarker(manager.current).plan.kind).toBe("restore");
  } finally {
    manager.close();
  }
});

it("rejects restore from a directory without a complete backup marker", async () => {
  const { configuration, source, backupTarget } = fixture();
  fs.mkdirSync(backupTarget);
  fs.writeFileSync(join(backupTarget, "loose-file"), "not a backup");
  const manager = new StorageLocationManager(configuration, source);
  try {
    await expect(manager.scheduleBackup({ kind: "restore", path: backupTarget })).rejects.toThrow(
      "STORAGE_FAILED",
    );
  } finally {
    manager.close();
  }
});

it("refuses nested, occupied and overlapping backup targets", async () => {
  const { root, configuration, source, backupTarget } = fixture();
  const manager = new StorageLocationManager(configuration, source);
  try {
    await expect(
      manager.scheduleBackup({ kind: "backup", path: join(source, "child") }),
    ).rejects.toThrow("STORAGE_PATH_INVALID");
    await expect(manager.scheduleBackup({ kind: "backup", path: root })).rejects.toThrow(
      "STORAGE_PATH_INVALID",
    );
    await expect(manager.scheduleBackup({ kind: "backup", path: source })).rejects.toThrow(
      "STORAGE_PATH_INVALID",
    );
    fs.mkdirSync(backupTarget);
    fs.writeFileSync(join(backupTarget, "user-file"), "keep");
    await expect(manager.scheduleBackup({ kind: "backup", path: backupTarget })).rejects.toThrow(
      "STORAGE_TARGET_OCCUPIED",
    );
    expect(fs.readFileSync(join(backupTarget, "user-file"), "utf8")).toBe("keep");
    // Only one plan may be pending.
    fs.rmSync(backupTarget, { recursive: true });
    const info = await manager.scheduleBackup({ kind: "backup", path: backupTarget });
    await expect(
      manager.scheduleBackup({ kind: "backup", path: join(root, "other") }),
    ).rejects.toThrow("BUSY");
    await expect(manager.schedule(join(root, "moved"))).rejects.toThrow("BUSY");
    expect((await manager.cancelBackup()).pendingBackup).toBeNull();
    expect(info.pendingBackupKind).toBe("backup");
  } finally {
    manager.close();
  }
});

it("fails closed on tampered backup content and keeps pending for recovery", async () => {
  const { configuration, source, backupTarget } = fixture();
  let manager = new StorageLocationManager(configuration, source);
  try {
    await manager.scheduleBackup({ kind: "backup", path: backupTarget });
  } finally {
    manager.close();
  }
  manager = new StorageLocationManager(configuration, source);
  try {
    expect(manager.info().pendingBackup).toBeNull();
    // Schedule a restore from the (still valid) backup.
    const info = await manager.scheduleBackup({ kind: "restore", path: backupTarget });
    expect(info.pendingBackupKind).toBe("restore");
  } finally {
    manager.close();
  }
  // Tamper with the backup after the restore was scheduled.
  fs.writeFileSync(join(backupTarget, "runtime", "notes.txt"), "tampered");
  expect(() => new StorageLocationManager(configuration, source)).toThrow("STORAGE_FAILED");
  StorageLocationManager.cancelPending(configuration);
  const recovered = new StorageLocationManager(configuration, source);
  expect(recovered.current).toBe(source);
  recovered.close();
});

it("createBackup and restoreBackup round-trip through the public API", () => {
  const { source, backupTarget, root, configuration } = fixture();
  createBackup(source, backupTarget, "11111111-1111-4111-8111-111111111111", configuration);
  const receipt = readBackupMarker(backupTarget);
  expect(receipt.complete).toBe(true);
  expect(receipt.files).toHaveLength(2);
  const restored = join(root, "restored");
  restoreBackup(backupTarget, restored, "22222222-2222-4222-8222-222222222222");
  expect(fs.readFileSync(join(restored, "runtime", "notes.txt"), "utf8")).toBe("line1\nline2\n");
  expect(fs.readFileSync(join(restored, "runtime", "runtime.sqlite"), "utf8")).toBe(
    "sqlite-bytes-中文",
  );
});
