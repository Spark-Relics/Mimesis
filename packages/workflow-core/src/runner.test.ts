import { AppError, DEMO_URL, type DocumentSnapshot, type Run } from "@clawler/contracts";
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
  it("waits for the final cancellation event before shutdown completes", async () => {
    const runner = new TaskRunner({
      navigate: () => new Promise(() => undefined),
      inspect: async () => result,
    });
    const events: Run[] = [];
    runner.subscribe((run) => events.push(run));
    runner.start(script, { url: DEMO_URL }, profileId, instanceId);
    await Promise.resolve();
    await runner.stop();
    expect(events.at(-1)?.status).toBe("cancelled");
    expect(events.at(-1)?.finishedAt).not.toBeNull();
    expect(runner.busy).toBe(false);
    await runner.stop();
  });
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

  it("records per-step evidence: the acting selector, the bound, and the failing error code", async () => {
    const evidence: ScriptDefinition = {
      manifest: script.manifest,
      async execute(ctx, input) {
        await ctx.step(
          "navigate",
          () => ctx.browser.navigate(input.url, ctx.signal),
          "x".repeat(400),
        );
        await ctx.step(
          "click",
          async () => {
            throw new AppError("TIMEOUT");
          },
          "click: .next",
        );
        return ctx.step("inspect", () => ctx.browser.inspect(ctx.signal));
      },
    };
    const runner = new TaskRunner({ navigate: async () => undefined, inspect: async () => result });
    const finished = completion(runner);
    runner.start(evidence, { url: DEMO_URL }, profileId, instanceId);
    const run = await finished;
    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("TIMEOUT");
    // Detail is bounded so long selectors cannot bloat persisted evidence.
    expect(run.steps[0]?.detail).toHaveLength(300);
    expect(run.steps[1]?.detail).toBe("click: .next");
    expect(run.steps.map((step) => step.errorCode)).toEqual([null, "TIMEOUT"]);
  });

  it("records a skipped step as neither success nor failure so the run stays diagnosable", async () => {
    const conditional: ScriptDefinition = {
      manifest: script.manifest,
      async execute(ctx) {
        ctx.skip("click", "click: #cookie (missing: #cookie-banner)");
        return ctx.step("inspect", () => ctx.browser.inspect(ctx.signal));
      },
    };
    const runner = new TaskRunner({ navigate: async () => undefined, inspect: async () => result });
    const finished = completion(runner);
    runner.start(conditional, { url: DEMO_URL }, profileId, instanceId);
    const run = await finished;
    expect(run.status).toBe("succeeded");
    expect(run.steps.map((step) => [step.kind, step.status])).toEqual([
      ["click", "skipped"],
      ["inspect", "succeeded"],
    ]);
    expect(run.steps[0]?.errorCode).toBeNull();
    expect(run.steps[0]?.finishedAt).not.toBeNull();
  });

  it("downgrades a recoverable best-effort failure to a skip and keeps the run going", async () => {
    const bestEffort: ScriptDefinition = {
      manifest: script.manifest,
      async execute(ctx) {
        await ctx.attempt(
          "click",
          async () => {
            throw new AppError("TIMEOUT");
          },
          "click: #optional",
        );
        return ctx.step("inspect", () => ctx.browser.inspect(ctx.signal));
      },
    };
    const runner = new TaskRunner({ navigate: async () => undefined, inspect: async () => result });
    const finished = completion(runner);
    runner.start(bestEffort, { url: DEMO_URL }, profileId, instanceId);
    const run = await finished;
    expect(run.status).toBe("succeeded");
    expect(run.steps.map((step) => [step.kind, step.status])).toEqual([
      ["click", "skipped"],
      ["inspect", "succeeded"],
    ]);
    // The cause stays on the skipped step instead of being lost or failing the run.
    expect(run.steps[0]?.detail).toBe("click: #optional (failed: TIMEOUT)");
    expect(run.steps[0]?.finishedAt).not.toBeNull();
  });
});
