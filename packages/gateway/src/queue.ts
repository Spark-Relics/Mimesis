import {
  AppError,
  type GatewayExecution,
  type GatewayJob,
  type GatewayState,
  type GatewaySubmission,
  gatewayExecutionSchema,
  gatewaySubmitSchema,
  type Run,
  runSchema,
  toErrorCode,
} from "@clawler/contracts";
import type { GatewayRepository } from "./repository";

export class GatewayError extends Error {
  constructor(
    public readonly code: "CONFLICT" | "QUEUE_FULL" | "UNAVAILABLE" | "RESULT_NOT_READY",
  ) {
    super(code);
  }
}

export interface GatewayExecutor {
  resolve(submission: GatewaySubmission): GatewayExecution;
  /** BUSY must be thrown before any browser action. Other failures are never auto-retried. */
  execute(execution: GatewayExecution, signal: AbortSignal): Promise<Run>;
}

export class GatewayQueue {
  private writes: Promise<unknown> = Promise.resolve();
  private worker: Promise<void> | undefined;
  private active: { id: string; controller: AbortController } | undefined;
  private closing = false;
  private storageFailed = false;
  private started = false;

  private constructor(
    private readonly repository: GatewayRepository,
    private readonly executor: GatewayExecutor,
    private state: GatewayState,
    private readonly maxPending: number,
    private readonly maxStored: number,
  ) {}

  static async open(
    repository: GatewayRepository,
    executor: GatewayExecutor,
    options: { maxPending?: number; maxStored?: number } = {},
  ): Promise<GatewayQueue> {
    const state = (await repository.load()) ?? { schemaVersion: 1, jobs: [] };
    // An interrupted browser action may have had side effects. Never replay it automatically.
    for (const job of state.jobs) {
      if (job.status !== "running") continue;
      job.status = "failed";
      job.errorCode = "INTERRUPTED";
      job.finishedAt = new Date().toISOString();
      await repository.archive(job);
    }
    await repository.save(state);
    return new GatewayQueue(
      repository,
      executor,
      state,
      options.maxPending ?? 100,
      options.maxStored ?? 1000,
    );
  }

  start(): void {
    this.assertAvailable();
    this.started = true;
    this.kick();
  }

  health() {
    return {
      ready: !this.closing && !this.storageFailed,
      queued: this.state.jobs.filter((job) => job.status === "queued").length,
      running: this.state.jobs.filter((job) => job.status === "running").length,
      stored: this.state.jobs.length,
      maxPending: this.maxPending,
      maxStored: this.maxStored,
      concurrency: 1,
    };
  }

  private assertAvailable(): void {
    if (this.storageFailed) throw new AppError("STORAGE_FAILED");
    if (this.closing) throw new GatewayError("UNAVAILABLE");
  }

  private async archive(job: GatewayJob): Promise<void> {
    try {
      await this.repository.archive(job);
    } catch (error) {
      this.storageFailed = true;
      this.active?.controller.abort(new AppError("STORAGE_FAILED"));
      throw new AppError("STORAGE_FAILED", { cause: error });
    }
  }

  private change<T>(mutate: (next: GatewayState) => T | Promise<T>): Promise<T> {
    const operation = this.writes.then(async () => {
      if (this.storageFailed) throw new AppError("STORAGE_FAILED");
      const next = structuredClone(this.state);
      const result = await mutate(next);
      try {
        await this.repository.save(next);
      } catch (error) {
        this.storageFailed = true;
        this.active?.controller.abort(new AppError("STORAGE_FAILED"));
        throw error;
      }
      this.state = next;
      return structuredClone(result);
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }

  async submit(
    input: unknown,
    idempotencyKey: string | null = null,
  ): Promise<{ job: GatewayJob; replayed: boolean }> {
    this.assertAvailable();
    const submission = gatewaySubmitSchema.parse(input);
    if (idempotencyKey !== null && !/^[\x21-\x7e]{1,128}$/u.test(idempotencyKey))
      throw new AppError("INVALID_INPUT");
    const result = await this.change((next) => {
      this.assertAvailable();
      const existing = next.jobs.find(
        (job) => idempotencyKey !== null && job.idempotencyKey === idempotencyKey,
      );
      if (existing) {
        if (JSON.stringify(existing.submission) !== JSON.stringify(submission))
          throw new GatewayError("CONFLICT");
        return { job: existing, replayed: true };
      }
      const pending = next.jobs.filter(
        (job) => job.status === "queued" || job.status === "running",
      ).length;
      if (pending >= this.maxPending || next.jobs.length >= this.maxStored)
        throw new GatewayError("QUEUE_FULL");
      const execution = gatewayExecutionSchema.parse(this.executor.resolve(submission));
      const job: GatewayJob = {
        id: crypto.randomUUID(),
        idempotencyKey,
        submission,
        execution,
        status: "queued",
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        errorCode: null,
        cancelRequested: false,
        run: null,
      };
      next.jobs.push(job);
      return { job, replayed: false };
    });
    this.kick();
    return result;
  }

  get(id: string): GatewayJob {
    this.assertAvailable();
    const job = this.state.jobs.find((entry) => entry.id === id);
    if (!job) throw new AppError("NOT_FOUND");
    return structuredClone(job);
  }

  list(offset = 0, limit = 50): { jobs: GatewayJob[]; total: number } {
    this.assertAvailable();
    return {
      jobs: structuredClone(
        this.state.jobs
          .slice()
          .reverse()
          .slice(offset, offset + limit),
      ),
      total: this.state.jobs.length,
    };
  }

  async cancel(id: string): Promise<GatewayJob> {
    this.assertAvailable();
    const job = await this.change(async (next) => {
      const current = next.jobs.find((entry) => entry.id === id);
      if (!current) throw new AppError("NOT_FOUND");
      if (current.status === "queued") {
        current.status = "cancelled";
        current.errorCode = "CANCELLED";
        current.cancelRequested = true;
        current.finishedAt = new Date().toISOString();
        await this.archive(current);
      } else if (current.status === "running") current.cancelRequested = true;
      return current;
    });
    if (job.cancelRequested && this.active?.id === id)
      this.active.controller.abort(new AppError("CANCELLED"));
    return job;
  }

  private kick(): void {
    if (!this.started || this.worker || this.closing || this.storageFailed) return;
    this.worker = this.drain()
      .catch(() => {
        this.storageFailed = true;
        this.active?.controller.abort(new AppError("STORAGE_FAILED"));
      })
      .finally(() => {
        this.worker = undefined;
        if (this.state.jobs.some((job) => job.status === "queued")) this.kick();
      });
  }

  private async drain(): Promise<void> {
    while (!this.closing && !this.storageFailed) {
      if (!this.state.jobs.some((job) => job.status === "queued")) return;
      const claimed = await this.change((next) => {
        const job = next.jobs.find((entry) => entry.status === "queued");
        if (!job || this.closing) return null;
        job.status = "running";
        job.startedAt = new Date().toISOString();
        return job;
      });
      if (!claimed) return;
      const controller = new AbortController();
      this.active = { id: claimed.id, controller };
      if (this.closing || this.state.jobs.find((job) => job.id === claimed.id)?.cancelRequested)
        controller.abort(new AppError("CANCELLED"));
      let run: Run | null = null;
      let errorCode: GatewayJob["errorCode"] = null;
      let busy = false;
      try {
        controller.signal.throwIfAborted();
        run = runSchema.parse(await this.executor.execute(claimed.execution, controller.signal));
        if (
          run.status === "running" ||
          run.instanceId !== claimed.execution.instance.id ||
          run.profileId !== claimed.execution.instance.profileId ||
          run.scriptId !== claimed.execution.instance.scriptId ||
          run.version !== claimed.execution.scriptVersion
        )
          throw new AppError("INTERNAL");
        if (run.status === "succeeded" && !run.result) throw new AppError("INVALID_INPUT");
      } catch (error) {
        errorCode = toErrorCode(error);
        busy = errorCode === "BUSY";
        run = null;
      }
      await this.change(async (next) => {
        const job = next.jobs.find((entry) => entry.id === claimed.id);
        if (!job) throw new AppError("INTERNAL");
        if (busy && !job.cancelRequested && !this.closing) {
          job.status = "queued";
          job.startedAt = null;
          return;
        }
        job.run = run;
        job.status = "failed";
        job.errorCode = errorCode;
        if (run) {
          job.status = run.status;
          job.errorCode = run.errorCode;
        }
        if (job.cancelRequested || this.closing || errorCode === "CANCELLED") {
          job.status = "cancelled";
          job.errorCode = "CANCELLED";
        }
        job.finishedAt = new Date().toISOString();
        await this.archive(job);
      });
      this.active = undefined;
      if (busy && !this.closing) await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.active?.controller.abort(new AppError("CANCELLED"));
    await this.worker;
    await this.writes;
  }
}
