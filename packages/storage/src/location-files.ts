import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { AppError } from "@clawler/contracts";

export function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** Resolve existing ancestors and refuse links/junctions before any migration writes. */
export function directoryPath(input: string): string {
  if (!isAbsolute(input) || input.includes("\0") || input.startsWith("\\\\"))
    throw new AppError("STORAGE_PATH_INVALID");
  const path = resolve(input);
  let ancestor = path;
  while (true) {
    try {
      const stat = lstatSync(ancestor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AppError("STORAGE_PATH_INVALID");
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    const parent = dirname(ancestor);
    if (ancestor === parent) break;
    ancestor = parent;
  }
  if (existsSync(path)) return realpathSync(path);
  return path;
}

export function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

/** Bootstrap only: no Electron sessions or runtime database have opened yet. */
export function writeBootstrap(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(handle, JSON.stringify(value, null, 2));
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function hashFile(file: string): string {
  const handle = openSync(file, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let length = readSync(handle, buffer);
    while (length > 0) {
      hash.update(buffer.subarray(0, length));
      length = readSync(handle, buffer);
    }
    return hash.digest("hex");
  } finally {
    closeSync(handle);
  }
}

export function lockDirectory(root: string): () => void {
  const file = resolve(root, ".mimesis.lock");
  if (existsSync(file)) {
    const previous = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown };
    if (typeof previous.pid !== "number" || !Number.isSafeInteger(previous.pid) || previous.pid < 1)
      throw new AppError("BUSY");
    try {
      process.kill(previous.pid, 0);
      throw new AppError("BUSY");
    } catch (error) {
      if (!hasCode(error, "ESRCH")) throw new AppError("BUSY");
    }
    unlinkSync(file);
  }
  const value = JSON.stringify({ pid: process.pid, token: crypto.randomUUID() });
  const handle = openSync(file, "wx", 0o600);
  try {
    writeFileSync(handle, value);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  return () => {
    if (existsSync(file) && readFileSync(file, "utf8") === value) unlinkSync(file);
  };
}
