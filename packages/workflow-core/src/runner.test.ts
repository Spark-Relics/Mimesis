import { DEMO_URL, type DocumentSnapshot, type Run } from "@clawler/contracts";
import type { BrowserPort, ScriptDefinition } from "@clawler/script-sdk";
import { describe, expect, it, vi } from "vitest";
import { TaskRunner } from "./index";

const profileId = "00000000-0000-4000-8000-000000000001";
const instanceId = "00000000-0000-4000-8000-000000000002";
const result: DocumentSnapshot = { title: "Test", url: DEMO_URL, headings: ["Example"], links: [] };
const script: ScriptDefinition = {
  manifest: {
    id: "sample",
    version: "1.0.0",
    sdkVersion: 1,
    ai: "disabled",
    implementation: "bundled",
  },
  async execute(ctx, input) {
    await ctx.step("navigate", () => ctx.browser.navigate(input.url, ctx.signal));
    return ctx.step("inspect", () => ctx.browser.inspect(ctx.signal));
  },
};

function completion(runner: TaskRunner): Promise<Run> {
  return new Promise((resolveRun) => {
    const unsubscribe = runner.subscribe((run) => {
      if (run.status !== "running") {
        unsubscribe();
        resolveRun(run);
      }
    });
  });
}

describe("script-only task runtime", () => {
  it("runs without any model dependency and emits verified steps and output", async () => {
    const browser = { navigate: vi.fn(async () => undefined), inspect: vi.fn(async () => result) };
    const runner = new TaskRunner(browser);
    const finished = completion(runner);
    runner.start(script, { url: DEMO_URL }, profileId, instanceId);
    const run = await finished;
    expect(run.status).toBe("succeeded");
    expect(run.result).toEqual(result);
    expect(run.steps.map((step) => step.status)).toEqual(["succeeded", "succeeded"]);
    expect(runner.busy).toBe(false);
  });

  it("enforces exclusive ownership and cancels a nonresponding browser operation", async () => {
    const browser: BrowserPort = {
      navigate: () => new Promise(() => undefined),
      inspect: async () => result,
    };
    const runner = new TaskRunner(browser);
    const finished = completion(runner);
    const run = runner.start(script, { url: DEMO_URL }, profileId, instanceId);
    await Promise.resolve();
    expect(() => runner.start(script, { url: DEMO_URL }, profileId, instanceId)).toThrow("BUSY");
    runner.cancel(run.id);
    const stopped = await finished;
    expect(stopped.status).toBe("cancelled");
    expect(stopped.result).toBeNull();
    expect(runner.busy).toBe(false);
  });

  it("returns timeout and releases the profile even if the operation stalls", async () => {
    const browser: BrowserPort = {
      navigate: () => new Promise(() => undefined),
      inspect: async () => result,
    };
    const runner = new TaskRunner(browser, 10);
    const finished = completion(runner);
    runner.start(script, { url: DEMO_URL }, profileId, instanceId);
    const run = await finished;
    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("TIMEOUT");
    expect(runner.busy).toBe(false);
  });

  it("validates output instead of claiming an invalid extraction succeeded", async () => {
    const browser: BrowserPort = {
      navigate: async () => undefined,
      inspect: async () => ({ ...result, title: null }) as unknown as DocumentSnapshot,
    };
    const runner = new TaskRunner(browser);
    const finished = completion(runner);
    runner.start(script, { url: DEMO_URL }, profileId, instanceId);
    expect((await finished).status).toBe("failed");
  });
});
