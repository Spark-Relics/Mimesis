import { AppError, documentSchema, type Run, type StepKind, toErrorCode } from "@clawler/contracts";
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

  start(script: ScriptDefinition, input: ScriptInput, profileId: string, instanceId: string): Run {
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
    const context: ScriptContext = {
      signal,
      browser: this.browser,
      step: async <T>(kind: StepKind, action: () => Promise<T>): Promise<T> => {
        signal.throwIfAborted();
        const step = {
          id: crypto.randomUUID(),
          kind,
          status: "running" as const,
          startedAt: new Date().toISOString(),
          finishedAt: null,
        };
        run.steps.push(step);
        const current = run.steps[run.steps.length - 1];
        if (!current) throw new AppError("INTERNAL");
        this.emit(run);
        try {
          const value = await abortable(action(), signal);
          signal.throwIfAborted();
          current.status = "succeeded";
          return value;
        } catch (error) {
          current.status = "failed";
          if (toErrorCode(error) === "CANCELLED") current.status = "cancelled";
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
