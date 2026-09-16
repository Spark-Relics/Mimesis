import type { GatewayState } from "@clawler/contracts";
import { expect, it, vi } from "vitest";
import { completedRun, execution, memoryRepository, submission } from "./fixtures.test-support";
import { GatewayQueue } from "./queue";

it("debug restart resume", async () => {
  const repository = memoryRepository();
  const succeed = vi.fn(async () => new Response(null, { status: 204 }));
  const original = await GatewayQueue.open(repository, { resolve: () => execution, execute: async () => completedRun() }, {
    fetch: succeed as unknown as typeof fetch,
  });
  const submitted = await original.submit(submission, null, { url: "http://127.0.0.1:9/hook" });
  original.start();
  await vi.waitFor(() =>
    expect((repository.stored as GatewayState & { deliveries?: Array<{ status: string }> })?.deliveries?.[0]?.status).toBe("delivered"),
  );
  await original.close();
  const state = repository.stored as GatewayState & { deliveries?: unknown[] };
  state.deliveries = [
    {
      jobId: submitted.job.id,
      delivery: { url: "http://127.0.0.1:9/hook", headers: {}, maxAttempts: 8, timeoutMs: 10000 },
      attempts: 1,
      status: "pending",
      lastAttemptedAt: new Date(Date.now() - 10_000).toISOString(),
      deliveredAt: null,
      lastStatusCode: 503,
      lastError: "service unavailable",
    },
  ];
  const retry = vi.fn(async () => new Response(null, { status: 204 }));
  const restored = await GatewayQueue.open(repository, { resolve: () => execution, execute: async () => completedRun() }, {
    fetch: retry as unknown as typeof fetch,
  });
  restored.start();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  console.log("started:", (restored as unknown as { started?: boolean }).started);
  console.log("health:", JSON.stringify(restored.health()));
  console.log("retry calls:", retry.mock.calls.length);
  console.log("stored deliveries:", JSON.stringify((repository.stored as GatewayState & { deliveries?: Array<{ status: string; attempts: number; lastError: string | null }> }).deliveries));
  await restored.close();
});
