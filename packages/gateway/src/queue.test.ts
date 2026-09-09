import { AppError, type GatewayExecution, type GatewayState } from "@clawler/contracts";
import { describe, expect, it, vi } from "vitest";
import { completedRun, execution, memoryRepository, submission } from "./fixtures.test-support";
import { GatewayQueue } from "./queue";

function executor() {
  return {
    resolve: vi.fn(() => structuredClone(execution)),
    execute: vi.fn(async (_execution: GatewayExecution) => completedRun()),
  };
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

  it("enforces backpressure, cancels queued jobs and keeps terminal history", async () => {
    const queue = await GatewayQueue.open(memoryRepository(), executor(), {
      maxPending: 1,
      maxStored: 2,
    });
    const first = await queue.submit(submission);
    await expect(queue.submit(submission)).rejects.toThrow("QUEUE_FULL");
    expect((await queue.cancel(first.job.id)).status).toBe("cancelled");
    await queue.submit(submission);
    expect(queue.list().total).toBe(2);
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
});
