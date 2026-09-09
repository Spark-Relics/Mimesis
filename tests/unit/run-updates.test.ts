import type { Run } from "@clawler/contracts";
import { expect, it } from "vitest";
import { mergeRun } from "../../apps/desktop/src/renderer/src/shared/presentation";

it("does not let a late start response overwrite a completed run event", () => {
  const completed: Run = {
    id: "run",
    instanceId: "instance",
    scriptId: "sample",
    version: "1",
    profileId: "profile",
    status: "succeeded",
    startedAt: "2026-09-06T00:00:00Z",
    finishedAt: "2026-09-06T00:00:01Z",
    result: null,
    steps: [],
    errorCode: null,
  };
  const incoming: Run = { ...completed, status: "running", finishedAt: null };
  expect(mergeRun([completed], incoming)[0]?.status).toBe("succeeded");
});
