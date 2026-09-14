import type {
  CollectionWorkflow,
  DocumentSnapshot,
  Extraction,
  ScriptManifest,
  StepKind,
  WorkflowAction,
} from "@clawler/contracts";

export interface BrowserAutomationPort {
  act(action: WorkflowAction, timeoutMs: number, signal: AbortSignal): Promise<void>;
  extract(input: Extraction, signal: AbortSignal): Promise<Array<Record<string, string>>>;
  /** Presence check used both for pagination and for `when.exists` conditions. */
  exists(selector: string, signal: AbortSignal): Promise<boolean>;
}

/** All browser capabilities are mediated by the host; scripts never receive WebContents. */
export interface BrowserPort {
  readonly automation?: BrowserAutomationPort;
  navigate(url: string, signal: AbortSignal): Promise<void>;
  inspect(signal: AbortSignal): Promise<DocumentSnapshot>;
}

export interface ScriptContext {
  readonly signal: AbortSignal;
  readonly browser: BrowserPort;
  step<T>(kind: StepKind, action: () => Promise<T>, detail?: string): Promise<T>;
  /**
   * Best-effort step: a recoverable failure is recorded as skipped and the run continues.
   * Cancellation still propagates, so aborting never reports an action as merely skipped.
   */
  attempt<T>(kind: StepKind, action: () => Promise<T>, detail?: string): Promise<T | undefined>;
  /** Records a step that was deliberately not executed, so evidence matches what happened. */
  skip(kind: StepKind, detail?: string): void;
}

export interface ScriptInput {
  url: string;
  workflow?: CollectionWorkflow;
  parameters?: Record<string, string>;
}

/** Bundled trusted scripts only. Untrusted source must use a future isolated runtime adapter. */
export interface ScriptDefinition {
  readonly timeoutMs?: number;
  readonly manifest: ScriptManifest;
  execute(context: ScriptContext, input: ScriptInput): Promise<DocumentSnapshot>;
}
