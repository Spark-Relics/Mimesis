import type { AutomationInstance } from "@clawler/contracts";
import { describe, expect, it } from "vitest";
import { advanceSchedule, armSchedule, clearSchedule, dueInstance } from "./schedule";

const base: AutomationInstance = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Watcher",
  scriptId: "collection-workflow",
  profileId: "22222222-2222-4222-8222-222222222222",
  targetUrl: "https://example.test/catalog",
  enabled: true,
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
  workflow: {
    version: 1,
    before: [],
    extract: { items: ".item", fields: [] },
    pagination: null,
    waitTimeoutMs: 300,
    maxRecords: 10,
    dedupe: [],
  },
  publishedVersionId: "33333333-3333-4333-8333-333333333333",
};

function scheduled(overrides: Partial<AutomationInstance>): AutomationInstance {
  return { ...base, schedule: { intervalMinutes: 30 }, ...overrides };
}

const now = new Date("2026-10-10T12:00:00.000Z");

describe("dueInstance", () => {
  it("returns nothing when no instance is scheduled", () => {
    expect(dueInstance([base], now)).toBeNull();
  });

  it("returns nothing before the due time and the instance once due", () => {
    const instance = scheduled({ nextRunAt: "2026-10-10T12:00:01.000Z" });
    expect(dueInstance([instance], now)).toBeNull();
    expect(dueInstance([instance], new Date("2026-10-10T12:00:01.000Z"))?.id).toBe(instance.id);
  });

  it("skips disabled or unpublished instances", () => {
    const disabled = scheduled({ nextRunAt: "2026-10-10T11:00:00.000Z", enabled: false });
    const unbound = scheduled({ nextRunAt: "2026-10-10T11:00:00.000Z", publishedVersionId: null });
    const draftless = scheduled({
      nextRunAt: "2026-10-10T11:00:00.000Z",
      workflow: undefined,
    });
    expect(dueInstance([disabled, unbound, draftless], now)).toBeNull();
  });

  it("prefers the earliest due time across instances", () => {
    const later = scheduled({
      id: "44444444-4444-4444-8444-444444444444",
      nextRunAt: "2026-10-10T11:30:00.000Z",
    });
    const earlier = scheduled({ nextRunAt: "2026-10-10T10:30:00.000Z" });
    expect(dueInstance([later, earlier], now)?.id).toBe(earlier.id);
  });
});

describe("schedule transitions", () => {
  it("arms the first run one interval from now", () => {
    const armed = armSchedule(base, 15, now);
    expect(armed.schedule).toEqual({ intervalMinutes: 15 });
    expect(armed.nextRunAt).toBe("2026-10-10T12:15:00.000Z");
  });

  it("advances by the configured interval from the given time", () => {
    const instance = scheduled({ nextRunAt: "2026-10-10T11:00:00.000Z" });
    const advanced = advanceSchedule(instance, now);
    expect(advanced.nextRunAt).toBe("2026-10-10T12:30:00.000Z");
    expect(advanceSchedule(base, now)).toBe(base);
  });

  it("clearing removes both keys without mutating the input", () => {
    const instance = scheduled({ nextRunAt: "2026-10-10T11:00:00.000Z" });
    const cleared = clearSchedule(instance);
    expect(cleared).not.toHaveProperty("schedule");
    expect(cleared).not.toHaveProperty("nextRunAt");
    expect(instance.schedule).toEqual({ intervalMinutes: 30 });
    expect(dueInstance([cleared], now)).toBeNull();
  });
});
