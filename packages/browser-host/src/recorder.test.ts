import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { BrowserRecorder } from "./recorder";

function fixture() {
  const emitter = new EventEmitter();
  let binding = "";
  const sendCommand = vi.fn(
    async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      if (method === "Runtime.addBinding") binding = String(params?.name);
      if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "script-1" };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 12 };
      return {};
    },
  );
  const contents = {
    debugger: Object.assign(emitter, { isAttached: () => true, sendCommand }),
    getURL: () => "https://example.com/",
    isDestroyed: () => false,
  } as unknown as WebContents;
  const emit = (value: unknown) =>
    emitter.emit("message", {}, "Runtime.bindingCalled", {
      name: binding,
      payload: JSON.stringify(value),
    });
  return { contents, emitter, sendCommand, emit };
}

describe("browser operation recording lifecycle", () => {
  it("coalesces consecutive input events, preserves order and counts unsupported actions", async () => {
    const { contents, emit } = fixture();
    const recorder = new BrowserRecorder();
    await recorder.start(contents);
    emit({ kind: "fill", selector: "#search", value: "a" });
    emit({ kind: "fill", selector: "#search", value: "ab" });
    emit({ kind: "click", selector: "#submit" });
    emit({ kind: "skipped" });
    const recording = await recorder.stop();
    expect(recording.actions).toEqual([
      { kind: "fill", selector: "#search", value: "ab" },
      { kind: "click", selector: "#submit" },
    ]);
    expect(recording.skipped).toBe(1);
    expect(recording.url).toBe("https://example.com/");
    expect(recorder.active).toBe(false);
  });

  it("removes live listeners, binding and future scripts, and permits a fresh session", async () => {
    const { contents, emitter, sendCommand, emit } = fixture();
    const recorder = new BrowserRecorder();
    await recorder.start(contents);
    await expect(recorder.start(contents)).rejects.toThrow("BUSY");
    await recorder.stop();
    expect(emitter.listenerCount("message")).toBe(0);
    expect(sendCommand).toHaveBeenCalledWith("Page.removeScriptToEvaluateOnNewDocument", {
      identifier: "script-1",
    });
    expect(
      sendCommand.mock.calls.some(
        ([method, params]) =>
          method === "Runtime.evaluate" && String(params?.expression).includes("_stop"),
      ),
    ).toBe(true);
    emit({ kind: "click", selector: "#late" });
    await recorder.start(contents);
    expect((await recorder.stop()).actions).toEqual([]);
  });

  it("waits for in-flight setup when stopped immediately and cleans the subsequently registered script", async () => {
    const { contents, emitter, sendCommand } = fixture();
    const recorder = new BrowserRecorder();
    const starting = recorder.start(contents);
    const assertion = expect(starting).rejects.toThrow("CANCELLED");
    const stopping = recorder.stop();
    const repeatedStop = recorder.stop();
    expect(recorder.active).toBe(true);
    await expect(recorder.start(contents)).rejects.toThrow("BUSY");
    expect(await repeatedStop).toEqual(await stopping);
    await assertion;
    expect(emitter.listenerCount("message")).toBe(0);
    expect(sendCommand).toHaveBeenCalledWith("Page.removeScriptToEvaluateOnNewDocument", {
      identifier: "script-1",
    });
    expect(recorder.active).toBe(false);
  });

  it("cleans partial registration and reports script installation failures", async () => {
    const { contents, emitter, sendCommand } = fixture();
    const original = sendCommand.getMockImplementation();
    sendCommand.mockImplementation(async (method, params) => {
      if (method === "Runtime.evaluate") return { exceptionDetails: { text: "failed" } };
      return original?.(method, params);
    });
    const recorder = new BrowserRecorder();
    await expect(recorder.start(contents)).rejects.toThrow("INTERNAL");
    expect(emitter.listenerCount("message")).toBe(0);
    expect(recorder.active).toBe(false);
    expect(sendCommand).toHaveBeenCalledWith("Page.removeScriptToEvaluateOnNewDocument", {
      identifier: "script-1",
    });
  });

  it("caps recordings and ignores events from unrelated debugger bindings", async () => {
    const { contents, emitter, emit } = fixture();
    const recorder = new BrowserRecorder();
    await recorder.start(contents);
    emitter.emit("message", {}, "Runtime.bindingCalled", { name: "unrelated", payload: "bad" });
    for (let index = 0; index < 22; index++) emit({ kind: "click", selector: `#button-${index}` });
    const recording = await recorder.stop();
    expect(recording.actions).toHaveLength(20);
    expect(recording.skipped).toBe(2);
  });
});
