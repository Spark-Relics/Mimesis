import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statfsSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { AppError, z } from "@clawler/contracts";
import { contains, directoryPath, hashFile, writeBootstrap } from "./location-files";

/**
 * Offline workspace backup and restore. Runs during startup bootstrap before any
 * Electron session or runtime database handle exists, so plain file copies of
 * the closed SQLite database are already consistent snapshots. The same
 * inventory → staged copy with per-file verification → receipt → atomic rename
 * semantics as directory migration guarantee that neither source nor destination
 * is ever left in a mixed state; original directories are never modified.
 */

export const backupPlanSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("backup"), id: z.string().uuid(), target: z.string() }),
  z.object({
    kind: z.literal("restore"),
    id: z.string().uuid(),
    source: z.string(),
    target: z.string(),
  }),
]);
export type BackupPlan = z.infer<typeof backupPlanSchema>;

const backupMarker = ".mimesis-backup.json";
const ignored = new Set([
  ".mimesis.lock",
  backupMarker,
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
]);

const fileSchema = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
});
type Entry = z.infer<typeof fileSchema>;

export const backupReceiptSchema = z.object({
  plan: backupPlanSchema,
  complete: z.boolean(),
  files: z.array(fileSchema),
});
export type BackupReceipt = z.infer<typeof backupReceiptSchema>;

function inventory(root: string, directory = root): Entry[] {
  const result: Entry[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (directory === root && ignored.has(name)) continue;
    const file = join(directory, name);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new AppError("STORAGE_PATH_INVALID");
    if (stat.isDirectory()) result.push(...inventory(root, file));
    else if (stat.isFile())
      result.push({ path: relative(root, file), bytes: stat.size, sha256: hashFile(file) });
    else throw new AppError("STORAGE_PATH_INVALID");
  }
  return result;
}

/** Read and validate the receipt stored inside a backup or staging directory. */
export function readBackupMarker(root: string): BackupReceipt {
  const marker = join(root, backupMarker);
  if (lstatSync(marker).isSymbolicLink()) throw new AppError("STORAGE_PATH_INVALID");
  return backupReceiptSchema.parse(JSON.parse(readFileSync(marker, "utf8")));
}

/**
 * Validate that the target is a creatable or empty directory that does not
 * overlap the active roots. Mirrors validateDestination constraints.
 */
export function validateBackupTarget(source: string, input: string, configurationRoot: string) {
  const target = directoryPath(input.trim());
  const current = directoryPath(source);
  if (
    contains(current, target) ||
    contains(target, current) ||
    contains(target, configurationRoot) ||
    contains(configurationRoot, target) ||
    target === dirname(target)
  )
    throw new AppError("STORAGE_PATH_INVALID");
  if (!existsSync(dirname(target))) throw new AppError("STORAGE_PATH_INVALID");
  if (existsSync(target) && readdirSync(target).length > 0)
    throw new AppError("STORAGE_TARGET_OCCUPIED");
  return target;
}

function sameInventory(left: Entry[], right: Entry[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Verified copy from source into an empty target. The receipt travels with the
 * copy so any later consumer can re-verify the full inventory. If a previous
 * attempt already promoted a complete copy for this plan id, it is re-verified
 * and treated as done (crash between rename and configuration commit).
 */
function transferVerified(
  plan: BackupPlan,
  source: string,
  target: string,
  expected?: BackupReceipt,
): void {
  const origin = directoryPath(source);
  const destination = directoryPath(target);
  const stage = `${destination}.mimesis-${plan.id}.staging`;
  if (existsSync(join(destination, backupMarker))) {
    const done = readBackupMarker(destination);
    if (
      done.plan.id !== plan.id ||
      !done.complete ||
      !sameInventory(inventory(destination), done.files)
    )
      throw new AppError("STORAGE_FAILED");
    return;
  }
  const files = inventory(origin);
  if (expected && (!expected.complete || !sameInventory(files, expected.files)))
    throw new AppError("STORAGE_FAILED");
  const disk = statfsSync(dirname(destination));
  if (
    disk.bavail * disk.bsize <
    files.reduce((sum, entry) => sum + entry.bytes, 0) + 64 * 1024 * 1024
  )
    throw new AppError("STORAGE_SPACE_LOW");
  if (existsSync(stage)) {
    directoryPath(stage);
    const previous = readBackupMarker(stage);
    if (previous.plan.id !== plan.id) throw new AppError("STORAGE_TARGET_OCCUPIED");
    const owned = new Set(previous.files.map((entry) => entry.path));
    if (
      inventory(stage).some(
        (entry) => !owned.has(entry.path) || !files.some((current) => current.path === entry.path),
      )
    )
      throw new AppError("STORAGE_TARGET_OCCUPIED");
  } else mkdirSync(stage);
  writeBootstrap(join(stage, backupMarker), { plan, complete: false, files });
  for (const entry of files) {
    const place = resolve(stage, entry.path);
    if (!contains(stage, place)) throw new AppError("STORAGE_PATH_INVALID");
    mkdirSync(dirname(place), { recursive: true });
    let flags = constants.COPYFILE_EXCL;
    if (existsSync(place)) flags = 0;
    copyFileSync(join(origin, entry.path), place, flags);
    const handle = openSync(place, "r+");
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    if (hashFile(place) !== entry.sha256) throw new AppError("STORAGE_FAILED");
  }
  if (!sameInventory(inventory(origin), files) || !sameInventory(inventory(stage), files))
    throw new AppError("STORAGE_FAILED");
  writeBootstrap(join(stage, backupMarker), { plan, complete: true, files });
  if (existsSync(destination)) {
    // Only an empty directory may be replaced; foreign content is refused.
    try {
      rmdirSync(destination);
    } catch {
      throw new AppError("STORAGE_TARGET_OCCUPIED");
    }
  }
  renameSync(stage, destination);
}

/**
 * Backup: verified standalone copy of the live root. The source is untouched
 * and keeps running as the active data directory.
 */
export function createBackup(
  source: string,
  target: string,
  id: string,
  configurationRoot: string,
): void {
  if (existsSync(join(target, backupMarker))) {
    // Completed copy from an earlier attempt of the same plan: verify and stop.
    const done = readBackupMarker(target);
    if (done.plan.id !== id || !done.complete || !sameInventory(inventory(target), done.files))
      throw new AppError("STORAGE_FAILED");
    return;
  }
  validateBackupTarget(source, target, configurationRoot);
  transferVerified({ kind: "backup", id, target }, source, target);
}

/**
 * Restore: verify the backup against its own receipt, then copy it into a fresh
 * target directory. The backup itself is never modified and the previous live
 * root is never deleted; the caller switches the configured directory only
 * after the verified copy exists.
 */
export function restoreBackup(source: string, target: string, id: string): void {
  const receipt = readBackupMarker(source);
  if (receipt.plan.kind !== "backup" || !receipt.complete) throw new AppError("STORAGE_FAILED");
  transferVerified({ kind: "restore", id, source, target }, source, target, receipt);
}
