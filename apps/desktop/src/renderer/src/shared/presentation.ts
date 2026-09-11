import { type ErrorCode, errorCodeSchema, type Run, type StepKind } from "@clawler/contracts";
import type { MessageKey } from "@clawler/i18n";

export const statusKeys: Record<Run["status"], MessageKey> = {
  running: "statusRunning",
  succeeded: "statusSucceeded",
  failed: "statusFailed",
  cancelled: "statusCancelled",
};
export const statusTones = {
  running: "accent",
  succeeded: "success",
  failed: "danger",
  cancelled: "neutral",
} as const;
export const stepKeys: Record<StepKind, MessageKey> = {
  navigate: "stepNavigate",
  inspect: "stepInspect",
  fill: "stepFill",
  click: "stepClick",
  wait: "stepWait",
  extract: "stepExtract",
};
export const errorKeys: Record<ErrorCode, MessageKey> = {
  INVALID_INPUT: "errorInvalidInput",
  FORBIDDEN: "errorForbidden",
  BUSY: "errorBusy",
  NOT_FOUND: "errorNotFound",
  NAVIGATION_FAILED: "errorNavigation",
  TIMEOUT: "errorTimeout",
  CANCELLED: "errorCancelled",
  STORAGE_FAILED: "errorStorage",
  STORAGE_PATH_INVALID: "errorStoragePath",
  STORAGE_TARGET_OCCUPIED: "errorStorageOccupied",
  STORAGE_SPACE_LOW: "errorStorageSpace",
  INTERNAL: "errorInternal",
  DESKTOP_REQUIRED: "desktopRequired",
};

export function errorMessageKey(error: unknown): MessageKey {
  if (error instanceof Error) {
    const parsed = errorCodeSchema.safeParse(error.message);
    if (parsed.success) return errorKeys[parsed.data];
  }
  return "errorInternal";
}

export function mergeRun(runs: Run[], incoming: Run): Run[] {
  const existing = runs.find((run) => run.id === incoming.id);
  if (existing?.finishedAt && incoming.status === "running") return runs;
  return [incoming, ...runs.filter((run) => run.id !== incoming.id)].slice(0, 50);
}
