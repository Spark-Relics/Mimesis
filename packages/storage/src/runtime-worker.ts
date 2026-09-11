import { parentPort, workerData } from "node:worker_threads";
import { z } from "@clawler/contracts";
import { RuntimeDatabase } from "./runtime-database";
import { runtimeRequestSchema } from "./runtime-protocol";

export function serveRuntimeDatabase(): void {
  const port = parentPort;
  if (!port) throw new Error("Storage requires a worker thread");
  const { file } = z.object({ file: z.string().min(1) }).parse(workerData);
  const database = new RuntimeDatabase(file);
  port.on("message", (input: unknown) => {
    const request = runtimeRequestSchema.parse(input);
    try {
      const value = database.dispatch(request.command);
      port.postMessage({ id: request.id, ok: true, value });
      if (request.command.method === "close") port.close();
    } catch {
      port.postMessage({ id: request.id, ok: false });
    }
  });
}
