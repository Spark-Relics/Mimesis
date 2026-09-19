import {
  AppError,
  type GatewayDelivery,
  type GatewayExecution,
  type GatewayJob,
  type GatewayState,
  type GatewaySubmission,
  gatewayExecutionSchema,
  gatewaySubmitSchema,
  type Run,
  runSchema,
  toErrorCode,
  webhookDeliverySchema,
  z,
} from "@clawler/contracts";
import { WebhookOutbox, type WebhookOutboxOptions } from "./outbox";
import type { GatewayRepository } from "./repository";
import { cleanResult } from "./results";

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

export interface GatewayQueueOptions {
  maxPending?: number;
  maxStored?: number;
  /** Byte budget for archived artifacts; oldest terminal jobs are evicted once exceeded. */
  maxArtifactBytes?: number;
  /** Bounded number of jobs the queue executes in parallel. Default 1, max 8. */
  concurrency?: number;
  fetch?: typeof fetch;
}

export type JobListener = (job: GatewayJob) => void;

export class GatewayQueue {
  private writes: Promise<unknown> = Promise.resolve();
  private readonly workers = new Set<Promise<void>>();
  private readonly active = new Map<string, AbortController>();
  private closing = false;
  private storageFailed = false;
  private started = false;
  private readonly listeners = new Map<string, Set<JobListener>>();

  private outbox: WebhookOutbox | undefined;

  private constructor(
    private readonly repository: GatewayRepository,
    private readonly executor: GatewayExecutor,
    private state: GatewayState,
    private readonly maxPending: number,
    private readonly maxStored: number,
    private readonly maxArtifactBytes: number,
    private readonly concurrency: number,
    private readonly fetchFn?: typeof fetch,
  ) {}

  static async open(
    repository: GatewayRepository,
    executor: GatewayExecutor,
    options: GatewayQueueOptions = {},
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
    const maxStored = options.maxStored ?? 1000;
    const concurrency = z
      .number()
      .int()
      .min(1)
      .max(8)
      .parse(options.concurrency ?? 1);
    await repository.save(state);
    const queue = new GatewayQueue(
      repository,
      executor,
      state,
      options.maxPending ?? 100,
      maxStored,
      options.maxArtifactBytes ?? 2 * 1024 * 1024 * 1024,
      concurrency,
      options.fetch,
    );
    // Never start the outbox loop here: running() is false until start() flips
    // `started`, so the loop would exit immediately and the still-pending loop
    // promise makes the later start() call skip the restart (dead deliveries).
    return queue;
  }

  private startOutbox(): void {
    const outboxOptions: WebhookOutboxOptions = {};
    if (this.fetchFn !== undefined) outboxOptions.fetch = this.fetchFn;
    if (!this.outbox) {
      this.outbox = new WebhookOutbox(
        {
          nextPending: () => {
            const pending = (this.state.deliveries ?? []).find(
              (entry) => entry.status === "pending",
            );
            if (!pending) return null;
            const job = this.state.jobs.find((entry) => entry.id === pending.jobId);
            let result: unknown = null;
            if (job?.run?.result && job.status === "succeeded")
              result = cleanResult(job.run.result, job.submission.cleaning);
            if (!result) return null;
            return { entry: structuredClone(pending), payload: JSON.stringify(result) };
          },
          commit: async (entry) => {
            await this.change((next) => {
              if (!next.deliveries) next.deliveries = [];
              const current = next.deliveries.find((item) => item.jobId === entry.jobId);
              if (current?.status !== "pending") return;
              Object.assign(current, structuredClone(entry));
            });
          },
          running: () => this.started && !this.closing && !this.storageFailed,
        },
        outboxOptions,
      );
    }
    this.outbox.start();
  }

  start(): void {
    this.assertAvailable();
    this.started = true;
    this.kick();
    if (this.state.deliveries?.length) this.startOutbox();
  }

  health() {
    const bytes = this.repository.artifactBytesByJob();
    const deliveries = this.state.deliveries ?? [];
    return {
      ready: !this.closing && !this.storageFailed,
      queued: this.state.jobs.filter((job) => job.status === "queued").length,
      running: this.state.jobs.filter((job) => job.status === "running").length,
      stored: this.state.jobs.length,
      maxPending: this.maxPending,
      maxStored: this.maxStored,
      artifactBytes: [...bytes.values()].reduce((total, value) => total + value, 0),
      maxArtifactBytes: this.maxArtifactBytes,
      concurrency: this.concurrency,
      deliveriesPending: deliveries.filter((entry) => entry.status === "pending").length,
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
      for (const controller of this.active.values())
        controller.abort(new AppError("STORAGE_FAILED"));
      throw new AppError("STORAGE_FAILED", { cause: error });
    }
  }

  private change<T>(mutate: (next: GatewayState) => T | Promise<T>): Promise<T> {
    const operation = this.writes.then(async () => {
      if (this.storageFailed) throw new AppError("STORAGE_FAILED");
      const previous = this.state;
      const next = structuredClone(this.state);
      const result = await mutate(next);
      // Retention: evict oldest terminal jobs so the durable history stays bounded.
      const evicted: string[] = [];
      const evictable = (job: GatewayJob) =>
        !evicted.includes(job.id) && job.status !== "queued" && job.status !== "running";
      const bytesByJob = this.repository.artifactBytesByJob();
      const bytes = (jobs: GatewayJob[]) =>
        jobs.reduce((total, job) => total + (bytesByJob.get(job.id) ?? 0), 0);
      while (
        next.jobs.length - evicted.length > this.maxStored &&
        next.jobs.length > evicted.length
      ) {
        const victim = next.jobs.find(evictable);
        if (!victim) break;
        evicted.push(victim.id);
      }
      // Disk quota: keep evicting oldest terminal jobs until the archive budget fits.
      let archiveBytes = bytes(next.jobs.filter((job) => !evicted.includes(job.id)));
      while (archiveBytes > this.maxArtifactBytes) {
        const victim = next.jobs.find(evictable);
        if (!victim) break;
        evicted.push(victim.id);
        archiveBytes -= bytesByJob.get(victim.id) ?? 0;
      }
      const remaining = next.jobs.filter((job) => !evicted.includes(job.id));
      if (remaining.length !== next.jobs.length) {
        if (next.deliveries)
          next.deliveries = next.deliveries.filter((entry) => !evicted.includes(entry.jobId));
      }
      // Keeping every job means the mutated snapshot is already the next durable state.
      let persisted: GatewayState = next;
      if (remaining.length !== next.jobs.length) persisted = { ...next, jobs: remaining };
      try {
        await this.repository.save(persisted, evicted);
      } catch (error) {
        this.storageFailed = true;
        for (const controller of this.active.values())
          controller.abort(new AppError("STORAGE_FAILED"));
        throw error;
      }
      this.state = persisted;
      for (const job of persisted.jobs) {
        const before = previous.jobs.find((entry) => entry.id === job.id);
        if (!before || before === job) continue;
        if (
          before.status !== job.status ||
          before.run !== job.run ||
          before.cancelRequested !== job.cancelRequested
        ) {
          const snapshot = structuredClone(job);
          for (const listener of this.listeners.get(job.id) ?? []) listener(snapshot);
        }
      }
      return structuredClone(result);
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }

  async submit(
    input: unknown,
    idempotencyKey: string | null = null,
    webhook: unknown = null,
  ): Promise<{ job: GatewayJob; replayed: boolean }> {
    this.assertAvailable();
    const submission = gatewaySubmitSchema.parse(input);
    let delivery: GatewayDelivery["delivery"] | null = null;
    if (webhook !== null) delivery = webhookDeliverySchema.parse(webhook);
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
      if (pending >= this.maxPending) throw new GatewayError("QUEUE_FULL");
      if (
        next.jobs.length >= this.maxStored &&
        !next.jobs.some((job) => job.status !== "queued" && job.status !== "running")
      )
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
      if (delivery) {
        const entry: GatewayDelivery = {
          jobId: job.id,
          delivery,
          attempts: 0,
          status: "pending",
          lastAttemptedAt: null,
          deliveredAt: null,
          lastStatusCode: null,
          lastError: null,
        };
        if (!next.deliveries) next.deliveries = [];
        next.deliveries.push(entry);
      }
      return { job, replayed: false };
    });
    this.kick();
    return result;
  }

  /** Notifies the listener on every persisted change of this job. No-op after close. */
  subscribe(id: string, listener: JobListener): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    const current = this.state.jobs.find((job) => job.id === id);
    if (current) listener(structuredClone(current));
    return () => {
      set?.delete(listener);
      if (set && set.size === 0 && this.listeners.get(id) === set) this.listeners.delete(id);
    };
  }

  get(id: string): GatewayJob {
    this.assertAvailable();
    const job = this.state.jobs.find((entry) => entry.id === id);
    if (!job) throw new AppError("NOT_FOUND");
    return structuredClone(job);
  }

  /**
   * Outbox entry tracking this job's webhook delivery, or null when the job has
   * no webhook. Lets a caller observe whether an at-least-once delivery has been
   * accepted, is still retrying, or was given up. Throws NOT_FOUND for an unknown job.
   */
  delivery(id: string): GatewayDelivery | null {
    this.assertAvailable();
    if (!this.state.jobs.some((entry) => entry.id === id)) throw new AppError("NOT_FOUND");
    const entry = (this.state.deliveries ?? []).find((item) => item.jobId === id);
    if (!entry) return null;
    return structuredClone(entry);
  }

  /**
   * Re-queues a given-up (`failed`) webhook delivery for a fresh round of attempts
   * without re-running the collection, restoring the full attempt budget. Only a
   * failed entry can be redriven: `delivered` is terminal and `pending` is already
   * scheduled. An unknown job or a job with no webhook throws NOT_FOUND.
   */
  async redeliver(id: string): Promise<GatewayDelivery> {
    this.assertAvailable();
    const entry = await this.change((next) => {
      if (!next.jobs.some((job) => job.id === id)) throw new AppError("NOT_FOUND");
      const delivery = next.deliveries?.find((item) => item.jobId === id);
      if (!delivery) throw new AppError("NOT_FOUND");
      if (delivery.status !== "failed") throw new GatewayError("CONFLICT");
      delivery.status = "pending";
      delivery.attempts = 0;
      delivery.lastAttemptedAt = null;
      delivery.deliveredAt = null;
      delivery.lastStatusCode = null;
      delivery.lastError = null;
      return delivery;
    });
    this.startOutbox();
    return entry;
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
    if (job.cancelRequested) this.active.get(id)?.abort(new AppError("CANCELLED"));
    return job;
  }

  private kick(): void {
    while (
      this.started &&
      !this.closing &&
      !this.storageFailed &&
      this.workers.size < this.concurrency &&
      this.state.jobs.some((job) => job.status === "queued")
    ) {
      const worker = this.drain()
        .catch(() => {
          this.storageFailed = true;
          for (const controller of this.active.values())
            controller.abort(new AppError("STORAGE_FAILED"));
        })
        .finally(() => {
          this.workers.delete(worker);
          if (this.state.jobs.some((job) => job.status === "queued")) this.kick();
        });
      this.workers.add(worker);
    }
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
      this.active.set(claimed.id, controller);
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
        if (
          job.status === "succeeded" &&
          next.deliveries?.some((entry) => entry.jobId === job.id && entry.status === "pending")
        )
          this.startOutbox();
      });
      this.active.delete(claimed.id);
      if (busy && !this.closing) await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.listeners.clear();
    for (const controller of this.active.values()) controller.abort(new AppError("CANCELLED"));
    await Promise.all([...this.workers]);
    await this.writes;
    await this.outbox?.stop();
  }
}
