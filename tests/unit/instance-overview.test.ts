import type { AutomationInstance, Run } from "@clawler/contracts";
import { expect, it } from "vitest";
import {
  filterInstances,
  summarizeInstances,
} from "../../apps/desktop/src/renderer/src/features/instances/overview";

const instance: AutomationInstance = {
  id: crypto.randomUUID(),
  name: "采购目录",
  scriptId: "page-inspector",
  profileId: crypto.randomUUID(),
  targetUrl: "https://catalog.example.com/items",
  enabled: true,
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
};
function run(status: Run["status"], startedAt: string): Run {
  return {
    id: crypto.randomUUID(),
    instanceId: instance.id,
    scriptId: instance.scriptId,
    version: "1.0.0",
    profileId: instance.profileId,
    status,
    startedAt,
    finishedAt: startedAt,
    steps: [],
    result: null,
    errorCode: null,
  };
}

it("does not invent success metrics or validated status without run evidence", () => {
  const summary = summarizeInstances({ instances: [instance], runs: [] });
  expect(summary.successRate).toBe("—");
  expect(summary.sampleSize).toBe(0);
  expect(summary.insight).toBe("unverified");
  expect(summary.target?.id).toBe(instance.id);
});

it("uses the latest run per instance and excludes cancellations from success rate", () => {
  const summary = summarizeInstances({
    instances: [instance],
    runs: [
      run("failed", "2026-09-09T00:00:00.000Z"),
      run("succeeded", "2026-09-09T00:02:00.000Z"),
      run("cancelled", "2026-09-09T00:01:00.000Z"),
    ],
  });
  expect(summary.successRate).toBe("50%");
  expect(summary.sampleSize).toBe(2);
  expect(summary.insight).toBe("healthy");
  expect(summary.latest.get(instance.id)?.status).toBe("succeeded");
});

it("prioritizes current failures while ignoring paused instances in diagnostics", () => {
  const failed = run("failed", instance.createdAt);
  expect(summarizeInstances({ instances: [instance], runs: [failed] }).insight).toBe("failed");
  expect(
    summarizeInstances({ instances: [{ ...instance, enabled: false }], runs: [failed] }).insight,
  ).toBe("empty");
});

it("combines case-insensitive URL/name search with enabled state", () => {
  const paused = { ...instance, id: crypto.randomUUID(), name: "备份", enabled: false };
  expect(filterInstances([instance, paused], " CATALOG.EXAMPLE ", "enabled")).toEqual([instance]);
  expect(filterInstances([instance, paused], "备份", "paused")).toEqual([paused]);
  expect(filterInstances([instance, paused], "missing", "all")).toEqual([]);
});
