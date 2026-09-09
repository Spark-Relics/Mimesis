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
  hasNext(selector: string, signal: AbortSignal): Promise<boolean>;
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
  step<T>(kind: StepKind, action: () => Promise<T>): Promise<T>;
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
