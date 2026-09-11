import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

/** Finish and sync a same-directory temporary file before replacing the destination. */
export async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
