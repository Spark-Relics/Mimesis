import type { DocumentSnapshot, ScriptManifest, StepKind } from "@clawler/contracts";

/** All browser capabilities are mediated by the host; scripts never receive WebContents. */
export interface BrowserPort {
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
}

/** Bundled trusted scripts only. Untrusted source must use a future isolated runtime adapter. */
export interface ScriptDefinition {
  readonly manifest: ScriptManifest;
  execute(context: ScriptContext, input: ScriptInput): Promise<DocumentSnapshot>;
}
