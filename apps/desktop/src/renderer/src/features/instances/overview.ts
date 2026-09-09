import type { AutomationInstance, Run, WorkspaceSnapshot } from "@clawler/contracts";

export type InstanceFilter = "all" | "enabled" | "paused";

export function filterInstances(
  instances: AutomationInstance[],
  query: string,
  filter: InstanceFilter,
) {
  const needle = query.trim().toLocaleLowerCase();
  return instances.filter((instance) => {
    if (filter === "enabled" && !instance.enabled) return false;
    if (filter === "paused" && instance.enabled) return false;
    return `${instance.name}\n${instance.targetUrl}`.toLocaleLowerCase().includes(needle);
  });
}

export function summarizeInstances(workspace: Pick<WorkspaceSnapshot, "instances" | "runs">) {
  const { instances, runs } = workspace;
  const latest = new Map<string, Run>();
  for (const run of runs) {
    const previous = latest.get(run.instanceId);
    if (!previous || previous.startedAt < run.startedAt) latest.set(run.instanceId, run);
  }
  const completed = runs.filter((run) => run.status === "succeeded" || run.status === "failed");
  let successRate = "—";
  if (completed.length) {
    successRate = `${Math.round((completed.filter((run) => run.status === "succeeded").length / completed.length) * 100)}%`;
  }
  const failed = instances.find(
    (instance) => instance.enabled && latest.get(instance.id)?.status === "failed",
  );
  const unverified = instances.find((instance) => instance.enabled && !latest.has(instance.id));
  const running = instances.find((instance) => latest.get(instance.id)?.status === "running");
  let insight: "failed" | "unverified" | "running" | "healthy" | "empty" = "healthy";
  let target: AutomationInstance | undefined;
  if (failed) {
    insight = "failed";
    target = failed;
  } else if (unverified) {
    insight = "unverified";
    target = unverified;
  } else if (running) {
    insight = "running";
    target = running;
  } else if (!instances.some((instance) => instance.enabled)) insight = "empty";
  return {
    enabled: instances.filter((instance) => instance.enabled).length,
    running: runs.filter((run) => run.status === "running").length,
    sampleSize: completed.length,
    successRate,
    insight,
    target,
    latest,
  };
}
