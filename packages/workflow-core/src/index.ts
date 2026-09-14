import {
  AppError,
  documentSchema,
  type Run,
  type StepKind,
  type StepRecord,
  toErrorCode,
} from "@clawler/contracts";
import type {
  BrowserPort,
  ScriptContext,
  ScriptDefinition,
  ScriptInput,
} from "@clawler/script-sdk";
import { abortable } from "./abortable";

type RunListener = (run: Run) => void;

/** Framework-independent execution state machine with exclusive browser ownership. */
export class TaskRunner {
  private active: { run: Run; controller: AbortController } | undefined;
  private readonly listeners = new Set<RunListener>();

  constructor(
    private readonly browser: BrowserPort,
    private readonly timeoutMs = 30_000,
  ) {}

  get busy(): boolean {
    return this.active !== undefined;
  }

  subscribe(listener: RunListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(
    script: ScriptDefinition,
    input: ScriptInput,
    profileId: string,
    instanceId: string,
    workflowVersionId: string | null = null,
  ): Run {
    if (this.active) throw new AppError("BUSY");
    const run: Run = {
      id: crypto.randomUUID(),
      instanceId,
      scriptId: script.manifest.id,
      version: script.manifest.version,
      profileId,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      steps: [],
      result: null,
      errorCode: null,
      workflowVersionId,
    };
    const controller = new AbortController();
    this.active = { run, controller };
    this.emit(run);
    queueMicrotask(() => {
      void this.execute(script, input, run, controller);
    });
    return structuredClone(run);
  }

  cancel(id: string): void {
    if (!this.active || this.active.run.id !== id) throw new AppError("NOT_FOUND");
    this.active.controller.abort(new AppError("CANCELLED"));
  }

  dispose(): void {
    this.active?.controller.abort(new AppError("CANCELLED"));
    this.listeners.clear();
  }

  private emit(run: Run): void {
    for (const listener of this.listeners) listener(structuredClone(run));
  }

  async stop(): Promise<void> {
    const active = this.active;
    if (!active) return;
    await new Promise<void>((resolve) => {
      const unsubscribe = this.subscribe((run) => {
        if (run.id === active.run.id && run.status !== "running") {
          unsubscribe();
          resolve();
        }
      });
      active.controller.abort(new AppError("CANCELLED"));
    });
  }

  private async execute(
    script: ScriptDefinition,
    input: ScriptInput,
    run: Run,
    controller: AbortController,
  ) {
    const timer = setTimeout(
      () => controller.abort(new AppError("TIMEOUT")),
      Math.min(script.timeoutMs ?? this.timeoutMs, 300_000),
    );
    const { signal } = controller;
    const record = (kind: StepKind, detail?: string): StepRecord => {
      const step: StepRecord = {
        id: crypto.randomUUID(),
        kind,
        status: "running",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        detail: (detail ?? "").slice(0, 300),
        errorCode: null,
      };
      run.steps.push(step);
      return step;
    };
    const context: ScriptContext = {
      signal,
      browser: this.browser,
      skip: (kind: StepKind, detail?: string): void => {
        if (signal.aborted) return;
        const current = record(kind, detail);
        // A skipped action never ran, so it is neither success nor failure.
        current.status = "skipped";
        current.finishedAt = current.startedAt;
        this.emit(run);
      },
      attempt: async <T>(
        kind: StepKind,
        action: () => Promise<T>,
        detail?: string,
      ): Promise<T | undefined> => {
        signal.throwIfAborted();
        const current = record(kind, detail);
        this.emit(run);
        try {
          const value = await abortable(action(), signal);
          signal.throwIfAborted();
          current.status = "succeeded";
          return value;
        } catch (error) {
          const code = toErrorCode(error);
          // Cancellation and the run-level timeout must still stop the run; only a
          // recoverable action failure is downgraded to a skip.
          if (signal.aborted) {
            current.status = "failed";
            if (code === "CANCELLED") current.status = "cancelled";
            current.errorCode = code;
            throw error;
          }
          current.status = "skipped";
          // The cause stays with the step so a skipped best-effort action is still diagnosable.
          current.detail = `${detail ?? ""} (failed: ${code})`.slice(0, 300);
          return undefined;
        } finally {
          current.finishedAt = new Date().toISOString();
          this.emit(run);
        }
      },
      step: async <T>(kind: StepKind, action: () => Promise<T>, detail?: string): Promise<T> => {
        signal.throwIfAborted();
        const current = record(kind, detail);
        this.emit(run);
        try {
          const value = await abortable(action(), signal);
          signal.throwIfAborted();
          current.status = "succeeded";
          return value;
        } catch (error) {
          current.status = "failed";
          // Evidence stays on the step that failed instead of only on the run.
          current.errorCode = toErrorCode(error);
          if (current.errorCode === "CANCELLED") current.status = "cancelled";
          throw error;
        } finally {
          current.finishedAt = new Date().toISOString();
          this.emit(run);
        }
      },
    };
    try {
      const result = await abortable(script.execute(context, input), signal);
      signal.throwIfAborted();
      run.result = documentSchema.parse(result);
      run.status = "succeeded";
    } catch (error) {
      run.errorCode = toErrorCode(error);
      run.status = "failed";
      if (run.errorCode === "CANCELLED") run.status = "cancelled";
    } finally {
      clearTimeout(timer);
      run.finishedAt = new Date().toISOString();
      this.active = undefined;
      this.emit(run);
    }
  }
}
