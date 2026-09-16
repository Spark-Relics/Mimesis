import {
  AppError,
  type GatewayExecution,
  type GatewayState,
  WebhookHttpStatusError,
} from "@clawler/contracts";
import { describe, expect, it, vi } from "vitest";
import { completedRun, execution, memoryRepository, submission } from "./fixtures.test-support";
import { GatewayQueue } from "./queue";

function executor() {
  return {
    resolve: vi.fn(() => structuredClone(execution)),
    execute: vi.fn(async (_execution: GatewayExecution) => completedRun()),
  };
}

type WithDeliveries = { deliveries?: Array<{ jobId: string; status: string }> };
/** Reads the durable state persisted by the memory repository for a delivery entry. */
function repositoryDelivery(repository: { stored?: GatewayState | undefined }, jobId: string) {
  return (repository.stored as (GatewayState & WithDeliveries) | undefined)?.deliveries?.find(
    (entry) => entry.jobId === jobId,
  );
}

describe("durable browser job queue", () => {
  it("acknowledges durable state, deduplicates concurrent requests and freezes the execution configuration", async () => {
    const repository = memoryRepository();
    const driver = executor();
    const queue = await GatewayQueue.open(repository, driver);
    const replies = await Promise.all(
      Array.from({ length: 8 }, () => queue.submit(submission, "same-key")),
    );
    expect(new Set(replies.map((reply) => reply.job.id)).size).toBe(1);
    expect(replies.filter((reply) => !reply.replayed)).toHaveLength(1);
    expect(repository.stored?.jobs).toHaveLength(1);
    driver.resolve.mockReturnValue({ ...execution, scriptVersion: "2.0.0" });
    await expect(
      queue.submit({ ...submission, targetUrl: "https://example.com/other" }, "same-key"),
    ).rejects.toThrow("CONFLICT");
    queue.start();
    await vi.waitFor(() => expect(queue.get(replies[0]?.job.id ?? "").status).toBe("succeeded"));
    expect(driver.execute).toHaveBeenCalledTimes(1);
    expect(driver.execute.mock.calls[0]?.[0]).toEqual(execution);
    expect(repository.archive).toHaveBeenCalledTimes(1);
    await queue.close();
  });

  it("rejects submissions while pending capacity is exhausted", async () => {
    const queue = await GatewayQueue.open(memoryRepository(), executor(), {
      maxPending: 1,
      maxStored: 10,
    });
    const first = await queue.submit(submission);
    await expect(queue.submit(submission)).rejects.toThrow("QUEUE_FULL");
    expect((await queue.cancel(first.job.id)).status).toBe("cancelled");
    await queue.submit(submission);
    expect(queue.list().total).toBe(2);
    await queue.close();
  });

  it("rejects when stored capacity is filled entirely by unfinished jobs", async () => {
    const queue = await GatewayQueue.open(memoryRepository(), executor(), { maxStored: 2 });
    await queue.submit(submission);
    await queue.submit(submission);
    await expect(queue.submit(submission)).rejects.toThrow("QUEUE_FULL");
    expect(queue.list().total).toBe(2);
    await queue.close();
  });

  it("evicts the oldest terminal jobs beyond maxStored and never unfinished ones", async () => {
    const repository = memoryRepository();
    const evictedOnDisk: string[] = [];
    vi.mocked(repository.save).mockImplementation(async (state, evicted = []) => {
      for (const id of evicted ?? []) evictedOnDisk.push(id);
      repository.stored = structuredClone(state);
    });
    const queue = await GatewayQueue.open(repository, executor(), { maxPending: 10, maxStored: 2 });
    const first = await queue.submit(submission);
    queue.start();
    await vi.waitFor(() => expect(queue.get(first.job.id).status).toBe("succeeded"));
    const second = await queue.submit(submission);
    const third = await queue.submit(submission);
    await vi.waitFor(() => expect(queue.get(third.job.id).status).toBe("succeeded"));
    // first was evicted when the third job committed; stored history stays bounded.
    expect(queue.list().total).toBe(2);
    expect(queue.list().jobs.map((job) => job.id)).toEqual([third.job.id, second.job.id]);
    expect(evictedOnDisk).toEqual([first.job.id]);
    expect(() => queue.get(first.job.id)).toThrow("NOT_FOUND");
    expect(repository.stored?.jobs).toHaveLength(2);
    await queue.close();
  });

  it("recovers queued jobs but never automatically replays an interrupted browser operation", async () => {
    const repository = memoryRepository();
    const original = await GatewayQueue.open(repository, executor());
    const first = await original.submit(submission, "interrupted");
    const second = await original.submit(submission, "waiting");
    await original.close();
    const stored = repository.stored as GatewayState;
    const interrupted = stored.jobs[0];
    if (!interrupted) throw new Error("Missing job");
    interrupted.status = "running";
    interrupted.startedAt = new Date().toISOString();
    const driver = executor();
    const restored = await GatewayQueue.open(repository, driver);
    expect(restored.get(first.job.id)).toMatchObject({
      status: "failed",
      errorCode: "INTERRUPTED",
    });
    expect((await restored.submit(submission, "interrupted")).replayed).toBe(true);
    restored.start();
    await vi.waitFor(() => expect(restored.get(second.job.id).status).toBe("succeeded"));
    expect(driver.execute).toHaveBeenCalledTimes(1);
    await restored.close();
  });

  it("waits for browser ownership and serializes executions", async () => {
    const driver = executor();
    driver.execute.mockRejectedValueOnce(new AppError("BUSY"));
    const queue = await GatewayQueue.open(memoryRepository(), driver);
    const first = await queue.submit(submission);
    const second = await queue.submit(submission);
    queue.start();
    await vi.waitFor(() => expect(queue.get(second.job.id).status).toBe("succeeded"));
    expect(queue.get(first.job.id).status).toBe("succeeded");
    expect(driver.execute).toHaveBeenCalledTimes(3);
    await queue.close();
  });

  it("propagates active cancellation and persists shutdown without losing waiting jobs", async () => {
    const driver = {
      resolve: () => execution,
      execute: vi.fn(async (_execution, signal: AbortSignal) => {
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
        return completedRun();
      }),
    };
    const repository = memoryRepository();
    const queue = await GatewayQueue.open(repository, driver);
    const first = await queue.submit(submission);
    const second = await queue.submit(submission);
    queue.start();
    await vi.waitFor(() => expect(driver.execute).toHaveBeenCalledTimes(1));
    await queue.cancel(first.job.id);
    await queue.close();
    expect(repository.stored?.jobs.find((job) => job.id === first.job.id)?.status).toBe(
      "cancelled",
    );
    expect(repository.stored?.jobs.find((job) => job.id === second.job.id)?.status).toBe("queued");
  });

  it("fails closed on queue persistence failure before executing anything", async () => {
    const repository = memoryRepository();
    const driver = executor();
    const queue = await GatewayQueue.open(repository, driver);
    vi.mocked(repository.save).mockRejectedValueOnce(new AppError("STORAGE_FAILED"));
    await expect(queue.submit(submission)).rejects.toThrow("STORAGE_FAILED");
    expect(driver.execute).not.toHaveBeenCalled();
    expect(queue.health().ready).toBe(false);
    expect(repository.stored?.jobs).toHaveLength(0);
    await queue.close();
  });

  it("does not report success when result archival fails", async () => {
    const repository = memoryRepository();
    vi.mocked(repository.archive).mockRejectedValue(new AppError("STORAGE_FAILED"));
    const queue = await GatewayQueue.open(repository, executor());
    await queue.submit(submission);
    queue.start();
    await vi.waitFor(() => expect(queue.health().ready).toBe(false));
    expect(repository.stored?.jobs[0]?.status).toBe("running");
    await queue.close();
  });

  it("evicts oldest terminal jobs when archived bytes exceed the disk quota", async () => {
    const repository = memoryRepository();
    // Each archived job accounts for 1024 bytes through the memory repository.
    const queue = await GatewayQueue.open(repository, executor(), {
      maxPending: 10,
      maxStored: 10,
      maxArtifactBytes: 2048,
    });
    queue.start();
    const first = await queue.submit(submission);
    await vi.waitFor(() => expect(queue.get(first.job.id).status).toBe("succeeded"));
    const second = await queue.submit(submission);
    await vi.waitFor(() => expect(queue.get(second.job.id).status).toBe("succeeded"));
    // Two archived jobs fit the 2048-byte budget exactly.
    expect(queue.list().total).toBe(2);
    expect(queue.health().artifactBytes).toBe(2048);
    const third = await queue.submit(submission);
    await vi.waitFor(() => expect(queue.get(third.job.id).status).toBe("succeeded"));
    // The third archive exceeds the budget, so the oldest terminal job is evicted.
    expect(queue.list().total).toBe(2);
    expect(queue.list().jobs.map((job) => job.id)).toEqual([third.job.id, second.job.id]);
    expect(() => queue.get(first.job.id)).toThrow("NOT_FOUND");
    expect(queue.health().artifactBytes).toBe(2048);
    await queue.close();
  });

  it("fails closed when retention eviction cannot delete an archive it cannot account for", async () => {
    const repository = memoryRepository();
    const queue = await GatewayQueue.open(repository, executor(), {
      maxPending: 10,
      maxStored: 1,
    });
    queue.start();
    const first = await queue.submit(submission);
    await vi.waitFor(() => expect(queue.get(first.job.id).status).toBe("succeeded"));
    // Simulate a manifest this process cannot account for after a restart.
    repository.bytesByJob.delete(first.job.id);
    await expect(queue.submit(submission)).rejects.toThrow("STORAGE_FAILED");
    expect(queue.health().ready).toBe(false);
    expect(() => queue.list()).toThrow("STORAGE_FAILED");
    // The durable state never claimed the eviction happened.
    expect(repository.stored?.jobs.map((job) => job.id)).toContain(first.job.id);
    await queue.close();
  });

  const webhook = { url: "http://127.0.0.1:9/hook" };

  it("delivers succeeded job results to the webhook and records delivery evidence", async () => {
    const repository = memoryRepository();
    const bodies: string[] = [];
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(null, { status: 200 });
    });
    const queue = await GatewayQueue.open(repository, executor(), {
      fetch: fetchFn as unknown as typeof fetch,
    });
    const job = await queue.submit(submission, null, webhook);
    queue.start();
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(repositoryDelivery(repository, job.job.id)?.status).toBe("delivered"),
    );
    const payload = JSON.parse(bodies[0] ?? "{}");
    // Cleaning defaults (trim + deduplicate) apply to the delivered payload.
    expect(payload).toEqual({
      title: "Catalog",
      url: "https://example.com/",
      headings: ["One"],
      links: [{ text: "=SUM(1,2)", href: "https://example.com/a" }],
    });
    await queue.close();
  });

  it("does not deliver for failed or cancelled jobs and leaves the outbox entry pending", async () => {
    const repository = memoryRepository();
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
    const driver = executor();
    driver.execute.mockRejectedValueOnce(new AppError("INTERNAL"));
    const queue = await GatewayQueue.open(repository, driver, {
      fetch: fetchFn as unknown as typeof fetch,
    });
    const first = await queue.submit(submission, null, webhook);
    const second = await queue.submit(submission, null, webhook);
    queue.start();
    await vi.waitFor(() => expect(queue.get(first.job.id).status).toBe("failed"));
    await queue.cancel(second.job.id);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(fetchFn).not.toHaveBeenCalled();
    expect(repositoryDelivery(repository, first.job.id)?.status).toBe("pending");
    await queue.close();
  });

  it("retries failed webhook attempts with the committed attempt count and gives up at maxAttempts", async () => {
    const repository = memoryRepository();
    const fetchFn = vi.fn(async () => new Response("no", { status: 503 }));
    const queue = await GatewayQueue.open(repository, executor(), {
      fetch: fetchFn as unknown as typeof fetch,
    });
    const job = await queue.submit(submission, null, { ...webhook, maxAttempts: 2 });
    queue.start();
    await vi.waitFor(() =>
      expect(repositoryDelivery(repository, job.job.id)?.status).toBe("failed"),
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const entry = repositoryDelivery(repository, job.job.id);
    expect(entry?.attempts).toBe(2);
    expect(entry?.lastStatusCode).toBe(503);
    await queue.close();
  });

  it("rejects non-http webhook URLs at submit", async () => {
    const queue = await GatewayQueue.open(memoryRepository(), executor());
    await expect(queue.submit(submission, null, { url: "file:///etc/passwd" })).rejects.toThrow();
    expect(queue.list().total).toBe(0);
    await queue.close();
  });

  it("keeps pending webhook deliveries of surviving jobs when retention eviction rebuilds the durable state", async () => {
    const repository = memoryRepository();
    const fetchFn = vi.fn(async () => new Response(null, { status: 503 }));
    const driver = executor();
    const queue = await GatewayQueue.open(repository, driver, {
      fetch: fetchFn as unknown as typeof fetch,
      maxStored: 2,
    });
    const first = await queue.submit(submission, null, webhook);
    const second = await queue.submit(submission, null, webhook);
    queue.start();
    await vi.waitFor(() => expect(queue.get(first.job.id).status).toBe("succeeded"));
    await vi.waitFor(() => expect(queue.get(second.job.id).status).toBe("succeeded"));
    // A third submit triggers retention eviction of the oldest terminal job (maxStored = 2);
    // the pending delivery of the surviving failed job must survive the state rebuild.
    await queue.submit(submission);
    expect(repository.stored?.jobs.map((job) => job.id)).not.toContain(first.job.id);
    expect(repositoryDelivery(repository, second.job.id)?.status).toBe("pending");
    expect(repository.stored?.deliveries?.map((entry) => entry.jobId)).toEqual([second.job.id]);
    await queue.close();
  });

  it("resumes pending webhook delivery after a restart without resending the archived job", async () => {
    const repository = memoryRepository();
    const succeed = vi.fn(async () => new Response(null, { status: 204 }));
    const original = await GatewayQueue.open(repository, executor(), {
      fetch: succeed as unknown as typeof fetch,
    });
    const submitted = await original.submit(submission, null, webhook);
    original.start();
    await vi.waitFor(() =>
      expect(repositoryDelivery(repository, submitted.job.id)?.status).toBe("delivered"),
    );
    await original.close();
    // Simulate a new pending delivery created just before a crash. This mirrors
    // the durable shape: submit() persists the webhookDeliverySchema-parsed
    // delivery, including its timeoutMs/maxAttempts defaults.
    const state = repository.stored as GatewayState;
    state.deliveries = [
      {
        jobId: submitted.job.id,
        delivery: { ...webhook, headers: {}, timeoutMs: 10_000, maxAttempts: 8 },
        attempts: 1,
        status: "pending",
        lastAttemptedAt: new Date().toISOString(),
        deliveredAt: null,
        lastStatusCode: 503,
        lastError: "service unavailable",
      },
    ];
    const retry = vi.fn(async () => new Response(null, { status: 204 }));
    const restored = await GatewayQueue.open(repository, executor(), {
      fetch: retry as unknown as typeof fetch,
    });
    restored.start();
    await vi.waitFor(() =>
      expect(repositoryDelivery(repository, submitted.job.id)?.status).toBe("delivered"),
    );
    expect(retry).toHaveBeenCalledTimes(1);
    await restored.close();
  });

  it("drops outbox entries when retention evicts their job", async () => {
    const repository = memoryRepository();
    const queue = await GatewayQueue.open(repository, executor(), {
      maxPending: 10,
      maxStored: 1,
      fetch: (async () => new Response(null, { status: 503 })) as unknown as typeof fetch,
    });
    queue.start();
    const first = await queue.submit(submission, null, webhook);
    await vi.waitFor(() => expect(queue.get(first.job.id).status).toBe("succeeded"));
    await queue.submit(submission);
    await vi.waitFor(() => expect(() => queue.get(first.job.id)).toThrow("NOT_FOUND"));
    expect(repository.stored?.deliveries ?? []).toHaveLength(0);
    expect(queue.health().deliveriesPending).toBe(0);
    await queue.close();
  });

  it("surfaces a WebhookHttpStatusError carrying the response status", () => {
    const error = new WebhookHttpStatusError(502);
    expect(error.statusCode).toBe(502);
    expect(error.message).toContain("502");
  });
});
