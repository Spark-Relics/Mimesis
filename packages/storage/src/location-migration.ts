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

export const transferSchema = z.object({
  id: z.string().uuid(),
  source: z.string(),
  target: z.string(),
});
export type Transfer = z.infer<typeof transferSchema>;
const receiptName = ".mimesis-transfer.json";
const ignored = new Set([
  ".mimesis.lock",
  receiptName,
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
]);
const fileSchema = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
});
const receiptSchema = transferSchema.extend({ complete: z.boolean(), files: z.array(fileSchema) });
type Entry = z.infer<typeof fileSchema>;

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
export function validateDestination(
  source: string,
  input: string,
  configurationRoot: string,
): string {
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

function receipt(root: string, transfer: Transfer) {
  const marker = join(root, receiptName);
  if (lstatSync(marker).isSymbolicLink()) throw new AppError("STORAGE_PATH_INVALID");
  const value = receiptSchema.parse(JSON.parse(readFileSync(marker, "utf8")));
  if (
    value.id !== transfer.id ||
    value.source !== transfer.source ||
    value.target !== transfer.target
  )
    throw new AppError("STORAGE_TARGET_OCCUPIED");
  return value;
}

/** Offline copy, verify, promote. Original files are never moved or deleted. */
export function migrateDirectory(transfer: Transfer, configurationRoot: string): void {
  const source = directoryPath(transfer.source);
  const target = directoryPath(transfer.target);
  const stage = `${target}.mimesis-${transfer.id}.staging`;
  // A completed target can exist if the process died before committing launcher.json.
  if (existsSync(join(target, receiptName))) {
    const completed = receipt(target, transfer);
    if (
      !completed.complete ||
      JSON.stringify(inventory(target)) !== JSON.stringify(completed.files) ||
      JSON.stringify(inventory(source)) !== JSON.stringify(completed.files)
    )
      throw new AppError("STORAGE_FAILED");
    return;
  }
  validateDestination(source, target, configurationRoot);
  const files = inventory(source);
  const disk = statfsSync(dirname(target));
  if (
    disk.bavail * disk.bsize <
    files.reduce((sum, entry) => sum + entry.bytes, 0) + 64 * 1024 * 1024
  )
    throw new AppError("STORAGE_SPACE_LOW");
  if (existsSync(stage)) {
    directoryPath(stage);
    const previous = receipt(stage, transfer);
    const owned = new Set(previous.files.map((entry) => entry.path));
    if (
      inventory(stage).some(
        (entry) => !owned.has(entry.path) || !files.some((current) => current.path === entry.path),
      )
    )
      throw new AppError("STORAGE_TARGET_OCCUPIED");
  } else mkdirSync(stage);
  writeBootstrap(join(stage, receiptName), { ...transfer, complete: false, files });
  for (const entry of files) {
    const destination = resolve(stage, entry.path);
    if (!contains(stage, destination)) throw new AppError("STORAGE_PATH_INVALID");
    mkdirSync(dirname(destination), { recursive: true });
    let flags = constants.COPYFILE_EXCL;
    if (existsSync(destination)) flags = 0;
    copyFileSync(join(source, entry.path), destination, flags);
    const handle = openSync(destination, "r+");
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    if (hashFile(destination) !== entry.sha256) throw new AppError("STORAGE_FAILED");
  }
  if (
    JSON.stringify(inventory(source)) !== JSON.stringify(files) ||
    JSON.stringify(inventory(stage)) !== JSON.stringify(files)
  )
    throw new AppError("STORAGE_FAILED");
  writeBootstrap(join(stage, receiptName), { ...transfer, complete: true, files });
  if (existsSync(target)) rmdirSync(target); // Non-recursive: fails if another writer populated it.
  renameSync(stage, target);
}
