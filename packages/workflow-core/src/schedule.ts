import type { AutomationInstance } from "@clawler/contracts";

export type Clock = () => Date;

/**
 * Scheduled execution is a pure decision over instance state: given the current
 * instances and a clock, pick the single instance whose next run is due. The
 * desktop scheduler owns the timer; these functions stay framework-independent
 * and deterministic so restart semantics are testable without Electron.
 */

/**
 * The instance the scheduler should run now, or null when nothing is due.
 * Candidates must have a schedule, a due `nextRunAt`, be enabled and be bound to
 * a published version — a scheduled instance without published content would
 * otherwise fail every tick. Ties resolve by the earliest due time, then by
 * workspace order, so behavior is deterministic.
 */
export function dueInstance(instances: AutomationInstance[], now: Date): AutomationInstance | null {
  let due: AutomationInstance | undefined;
  for (const instance of instances) {
    if (!instance.schedule || instance.nextRunAt === undefined) continue;
    if (!instance.enabled) continue;
    if (instance.publishedVersionId === null || !instance.workflow) continue;
    if (Date.parse(instance.nextRunAt) > now.getTime()) continue;
    if (due === undefined || Date.parse(instance.nextRunAt) < Date.parse(due.nextRunAt ?? ""))
      due = instance;
  }
  return due ?? null;
}

/** Moves the schedule forward by one interval from the given time. */
export function advanceSchedule(instance: AutomationInstance, now: Date): AutomationInstance {
  if (!instance.schedule) return instance;
  return {
    ...instance,
    nextRunAt: new Date(now.getTime() + instance.schedule.intervalMinutes * 60_000).toISOString(),
  };
}

/** Arms a new interval; the first automatic run happens one interval from now. */
export function armSchedule(
  instance: AutomationInstance,
  intervalMinutes: number,
  now: Date,
): AutomationInstance {
  return {
    ...instance,
    schedule: { intervalMinutes },
    nextRunAt: new Date(now.getTime() + intervalMinutes * 60_000).toISOString(),
  };
}

/** Removes the schedule and any pending due time. */
export function clearSchedule(instance: AutomationInstance): AutomationInstance {
  const next = { ...instance };
  delete next.schedule;
  delete next.nextRunAt;
  return next;
}
