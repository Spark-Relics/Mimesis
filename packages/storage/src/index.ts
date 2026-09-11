import type { StoredState } from "./state";

export type { StoredState } from "./state";
export interface WorkspaceRepository {
  load(): Promise<StoredState | undefined>;
  save(state: StoredState): Promise<void>;
}
