import {
  AppError,
  type GatewayExecution,
  type GatewayJob,
  type GatewayState,
  type Run,
} from "@clawler/contracts";
import { vi } from "vitest";
import type { GatewayRepository } from "./repository";

export const execution: GatewayExecution = {
  instance: {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Catalog",
    scriptId: "page-inspector",
    profileId: "00000000-0000-4000-8000-000000000002",
    enabled: true,
    targetUrl: "https://example.com/",
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
  },
  scriptVersion: "1.0.0",
};
export const submission = { instanceId: execution.instance.id };
export function completedRun(): Run {
  return {
    id: crypto.randomUUID(),
    instanceId: execution.instance.id,
    profileId: execution.instance.profileId,
    scriptId: execution.instance.scriptId,
    version: execution.scriptVersion,
    status: "succeeded",
    steps: [],
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    errorCode: null,
    result: {
      title: " Catalog ",
      url: execution.instance.targetUrl,
      headings: ["One", " One "],
      links: [{ text: " =SUM(1,2)", href: "https://example.com/a" }],
    },
  };
}

export function memoryRepository(
  initial?: GatewayState,
): GatewayRepository & { stored: GatewayState | undefined; bytesByJob: Map<string, number> } {
  const repository = {
    stored: initial,
    bytesByJob: new Map<string, number>(),
    load: vi.fn(async () => structuredClone(repository.stored)),
    save: vi.fn(async (state: GatewayState, evicted: string[] = []) => {
      for (const job of evicted)
        if (!repository.bytesByJob.delete(job)) throw new AppError("STORAGE_FAILED");
      repository.stored = structuredClone(state);
    }),
    archive: vi.fn(async (job: GatewayJob) => {
      repository.bytesByJob.set(job.id, 1024);
    }),
    // Mirrors the durable repository: bytes stay queryable until the archive is actually evicted.
    artifactBytesByJob: vi.fn(() => new Map(repository.bytesByJob)),
  };
  return repository;
}
