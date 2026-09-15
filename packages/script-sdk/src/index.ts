import type {
  CollectionRecord,
  CollectionWorkflow,
  DocumentSnapshot,
  Extraction,
  ScriptManifest,
  StepKind,
  WorkflowAction,
} from "@clawler/contracts";

export interface BrowserAutomationPort {
  act(action: WorkflowAction, timeoutMs: number, signal: AbortSignal): Promise<void>;
  extract(input: Extraction, signal: AbortSignal): Promise<CollectionRecord[]>;
  /** Presence check used both for pagination and for `when.exists` conditions. */
  exists(selector: string, signal: AbortSignal): Promise<boolean>;
  /** Records the current list items so `actOnItem` can address one of them by index. Returns the count. */
  snapshotItems(itemsSelector: string, signal: AbortSignal): Promise<number>;
  /** Acts on a previously snapshotted list item, resolving `action.selector` within that item. */
  actOnItem(
    index: number,
    action: WorkflowAction,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void>;
}

/** All browser capabilities are mediated by the host; scripts never receive WebContents. */
export interface BrowserPort {
  readonly automation?: BrowserAutomationPort;
  navigate(url: string, signal: AbortSignal): Promise<void>;
  /** Returns to the previous page when the host supports browser history. */
  goBack?(signal: AbortSignal): Promise<void>;
  inspect(signal: AbortSignal): Promise<DocumentSnapshot>;
}

/** HTTP request capability mediated by the host; scripts never import network modules. */
export interface HttpPort {
  /** `expectStatus`/size bounding happens at the caller; this only performs a bounded fetch. */
  fetch(
    request: { method: string; url: string; headers: Record<string, string>; body?: string },
    timeoutMs: number,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<{ status: number; body: string }>;
}

export interface ScriptContext {
  readonly signal: AbortSignal;
  readonly browser: BrowserPort;
  /** Optional so pure-browser scripts and tests do not need a network implementation. */
  readonly http?: HttpPort;
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
  /** Previous run's watermark value; enables incremental collection when the workflow configures one. */
  watermark?: string;
}

/** Bundled trusted scripts only. Untrusted source must use a future isolated runtime adapter. */
export interface ScriptDefinition {
  readonly timeoutMs?: number;
  readonly manifest: ScriptManifest;
  execute(context: ScriptContext, input: ScriptInput): Promise<DocumentSnapshot>;
}
