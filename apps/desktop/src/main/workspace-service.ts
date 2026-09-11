import { BrowserHost } from "@clawler/browser-host";
import {
  AppError,
  type AutomationInstance,
  type DesktopRequest,
  type GatewayExecution,
  type GatewaySubmission,
  IPC,
  type Profile,
  type Run,
  validateNavigationUrl,
  type WorkspaceSnapshot,
} from "@clawler/contracts";
import { resolveWorkflow, ScriptRegistry } from "@clawler/script-registry";
import type { StoredState, WorkspaceRepository } from "@clawler/storage";
import { TaskRunner } from "@clawler/workflow-core";
import type { BrowserWindow } from "electron";

export class WorkspaceService {
  private readonly registry = new ScriptRegistry();
  private readonly host: BrowserHost;
  private readonly runner: TaskRunner;
  private state: StoredState;
  private mutationPending = false;
  private storageFailed = false;
  private pendingRunSave: Promise<void> = Promise.resolve();

  private constructor(
    private readonly window: BrowserWindow,
    private readonly repository: WorkspaceRepository,
    state: StoredState,
  ) {
    this.state = state;
    this.host = new BrowserHost(window);
    this.runner = new TaskRunner(this.host);
    this.runner.subscribe((run) => this.recordRun(run));
    this.host.selectProfile(this.selectedProfile());
  }

  static async create(
    window: BrowserWindow,
    repository: WorkspaceRepository,
  ): Promise<WorkspaceService> {
    let state = await repository.load();
    if (!state) {
      const now = new Date().toISOString();
      const profile: Profile = {
        id: crypto.randomUUID(),
        name: "Default",
        createdAt: now,
      };
      const instance: AutomationInstance = {
        id: crypto.randomUUID(),
        name: "Page inspector",
        scriptId: "page-inspector",
        profileId: profile.id,
        targetUrl: "clawler-demo://catalog/",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      };
      state = {
        schemaVersion: 3,
        instances: [instance],
        profiles: [profile],
        selectedProfileId: profile.id,

        runs: [],
      };
    }
    for (const run of state.runs) {
      if (run.status === "running") {
        run.status = "failed";
        run.errorCode = "INTERNAL";
        run.finishedAt = new Date().toISOString();
      }
    }
    await repository.save(state);
    return new WorkspaceService(window, repository, state);
  }

  private selectedProfile(): Profile {
    const profile = this.state.profiles.find((entry) => entry.id === this.state.selectedProfileId);
    if (!profile) throw new AppError("NOT_FOUND");
    return profile;
  }

  private recordRun(run: Run): void {
    this.state.runs = [run, ...this.state.runs.filter((entry) => entry.id !== run.id)].slice(0, 50);
    this.pendingRunSave = this.repository.save(this.state);
    void this.pendingRunSave.catch(() => {
      this.storageFailed = true;
    });
    if (!this.window.isDestroyed()) this.window.webContents.send(IPC.runChanged, run);
  }

  private assertIdle(): void {
    if (this.storageFailed) throw new AppError("STORAGE_FAILED");
    if (this.runner.busy || this.mutationPending) throw new AppError("BUSY");
  }

  listInstances(): AutomationInstance[] {
    return structuredClone(this.state.instances);
  }

  resolve(submission: GatewaySubmission): GatewayExecution {
    if (this.storageFailed) throw new AppError("STORAGE_FAILED");
    const instance = this.state.instances.find((entry) => entry.id === submission.instanceId);
    if (!instance) throw new AppError("NOT_FOUND");
    if (!instance.enabled) throw new AppError("FORBIDDEN");
    const script = this.registry.get(instance.scriptId);
    if (instance.workflow) resolveWorkflow(instance.workflow, submission.parameters);
    return {
      instance: {
        ...instance,
        targetUrl: validateNavigationUrl(submission.targetUrl ?? instance.targetUrl),
      },
      scriptVersion: script.manifest.version,
      ...(submission.parameters && { parameters: submission.parameters }),
    };
  }

  async execute(execution: GatewayExecution, signal: AbortSignal): Promise<Run> {
    this.assertIdle();
    if (this.host.recorder.active) throw new AppError("BUSY");
    signal.throwIfAborted();
    const { instance } = execution;
    const current = this.state.instances.find((entry) => entry.id === instance.id);
    if (!current) throw new AppError("NOT_FOUND");
    if (!current.enabled) throw new AppError("FORBIDDEN");
    const profile = this.state.profiles.find((entry) => entry.id === instance.profileId);
    if (!profile) throw new AppError("NOT_FOUND");
    const script = this.registry.get(instance.scriptId);
    if (script.manifest.version !== execution.scriptVersion) throw new AppError("INVALID_INPUT");
    this.host.selectProfile(profile);
    let runId: string | undefined;
    let unsubscribe = () => {};
    const abort = () => {
      if (runId && this.runner.busy) this.runner.cancel(runId);
    };
    try {
      const completed = new Promise<Run>((resolveRun) => {
        unsubscribe = this.runner.subscribe((run) => {
          if (run.id === runId && run.status !== "running") {
            runId = undefined;
            resolveRun(run);
          }
        });
      });
      runId = this.runner.start(
        script,
        {
          url: instance.targetUrl,
          ...(instance.workflow && { workflow: instance.workflow }),
          ...(execution.parameters && { parameters: execution.parameters }),
        },
        profile.id,
        instance.id,
      ).id;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const run = await completed;
      await this.pendingRunSave;
      return run;
    } finally {
      unsubscribe();
      signal.removeEventListener("abort", abort);
    }
  }

  async flush(): Promise<void> {
    await this.pendingRunSave;
  }

  private async updateState(next: StoredState): Promise<void> {
    if (this.mutationPending) throw new AppError("BUSY");
    this.mutationPending = true;
    try {
      await this.repository.save(next);
      this.state = next;
    } finally {
      this.mutationPending = false;
    }
  }

  async dispatch(request: DesktopRequest): Promise<unknown> {
    switch (request.method) {
      case "recording.start":
        this.assertIdle();
        this.mutationPending = true;
        try {
          await this.host.startRecording();
        } finally {
          this.mutationPending = false;
        }
        return null;
      case "recording.stop":
        return this.host.recorder.stop();
      case "workflow.save": {
        this.assertIdle();
        if (this.host.recorder.active) throw new AppError("BUSY");
        const current = this.state.instances.find((instance) => instance.id === request.instanceId);
        if (!current) throw new AppError("NOT_FOUND");
        const profileId = request.input?.profileId ?? current.profileId;
        if (!this.state.profiles.some((profile) => profile.id === profileId))
          throw new AppError("NOT_FOUND");
        const instance = {
          ...current,
          ...request.input,
          targetUrl: validateNavigationUrl(request.input?.targetUrl ?? current.targetUrl),
          scriptId: "collection-workflow",
          workflow: request.workflow,
          updatedAt: new Date().toISOString(),
        };
        await this.updateState({
          ...this.state,
          instances: this.state.instances.map((entry) => {
            if (entry.id === instance.id) return instance;
            return entry;
          }),
        });
        return instance;
      }
      case "workspace.get": {
        if (this.storageFailed) throw new AppError("STORAGE_FAILED");
        return {
          ...structuredClone(this.state),
          scripts: this.registry.list(),
        } satisfies WorkspaceSnapshot;
      }
      case "profiles.create": {
        this.assertIdle();
        const profile = {
          id: crypto.randomUUID(),
          name: request.name,
          createdAt: new Date().toISOString(),
        };
        await this.updateState({ ...this.state, profiles: [...this.state.profiles, profile] });
        return profile;
      }
      case "profiles.select": {
        this.assertIdle();
        if (this.host.recorder.active) throw new AppError("BUSY");
        if (!this.state.profiles.some((profile) => profile.id === request.id))
          throw new AppError("NOT_FOUND");
        await this.updateState({ ...this.state, selectedProfileId: request.id });
        this.host.selectProfile(this.selectedProfile());
        return null;
      }
      case "instances.create": {
        this.assertIdle();
        const now = new Date().toISOString();
        const instance: AutomationInstance = {
          id: crypto.randomUUID(),
          name: request.name,
          scriptId: "page-inspector",
          profileId: this.state.selectedProfileId,
          targetUrl: "clawler-demo://catalog/",
          enabled: true,
          createdAt: now,
          updatedAt: now,
        };
        await this.updateState({ ...this.state, instances: [...this.state.instances, instance] });
        return instance;
      }
      case "instances.update": {
        this.assertIdle();
        if (!this.state.profiles.some((profile) => profile.id === request.input.profileId))
          throw new AppError("NOT_FOUND");
        const targetUrl = validateNavigationUrl(request.input.targetUrl);
        const current = this.state.instances.find((instance) => instance.id === request.id);
        if (!current) throw new AppError("NOT_FOUND");
        const instance: AutomationInstance = {
          ...current,
          ...request.input,
          targetUrl,
          updatedAt: new Date().toISOString(),
        };
        await this.updateState({
          ...this.state,
          instances: this.state.instances.map((entry) => {
            if (entry.id === instance.id) return instance;
            return entry;
          }),
        });
        return instance;
      }
      case "browser.bounds":
        this.host.setBounds(request.bounds);
        return null;
      case "browser.navigate": {
        this.assertIdle();
        this.mutationPending = true;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new AppError("TIMEOUT")), 30_000);
        try {
          await this.host.navigate(request.url, controller.signal);
        } finally {
          clearTimeout(timer);
          this.mutationPending = false;
        }
        return null;
      }
      case "window.control": {
        if (this.window.isDestroyed()) return null;
        if (request.action === "minimize") this.window.minimize();
        if (request.action === "toggle-maximize") {
          if (this.window.isMaximized()) this.window.unmaximize();
          else this.window.maximize();
        }
        if (request.action === "close") this.window.close();
        return null;
      }
      case "runs.start": {
        this.assertIdle();
        if (this.host.recorder.active) throw new AppError("BUSY");
        const instance = this.state.instances.find((entry) => entry.id === request.instanceId);
        if (!instance) throw new AppError("NOT_FOUND");
        if (!instance.enabled) throw new AppError("FORBIDDEN");
        const profile = this.state.profiles.find((entry) => entry.id === instance.profileId);
        if (!profile) throw new AppError("NOT_FOUND");
        const url = validateNavigationUrl(instance.targetUrl);
        if (instance.workflow) resolveWorkflow(instance.workflow, request.parameters);
        this.host.selectProfile(profile);
        return this.runner.start(
          this.registry.get(instance.scriptId),
          {
            url,
            ...(instance.workflow && { workflow: instance.workflow }),
            ...(request.parameters && { parameters: request.parameters }),
          },
          instance.profileId,
          instance.id,
        );
      }
      case "runs.cancel":
        this.runner.cancel(request.id);
        return null;
    }
  }

  dispose(): void {
    this.runner.dispose();
    this.host.dispose();
  }
}
