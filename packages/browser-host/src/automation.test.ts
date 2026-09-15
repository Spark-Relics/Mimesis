import { AppError, type Extraction } from "@clawler/contracts";
import type { WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserAutomation } from "./automation";

const extraction: Extraction = {
  items: ".item",
  fields: [{ name: "name", selector: "", attribute: "text", required: true }],
};
function fixture() {
  const sendCommand = vi.fn(
    async (_method: string, _params?: Record<string, unknown>): Promise<unknown> => ({
      result: { value: { ready: true, x: 10, y: 20 } },
    }),
  );
  const isLoadingMainFrame = vi.fn(() => false);
  const contents = {
    debugger: { isAttached: () => true, sendCommand },
    isLoadingMainFrame,
  } as unknown as WebContents;
  return { automation: new BrowserAutomation(() => contents), sendCommand, isLoadingMainFrame };
}
afterEach(() => vi.useRealTimers());

describe("browser action mediation", () => {
  it("waits through navigation and sends a real pressed/released input pair", async () => {
    vi.useFakeTimers();
    const { automation, sendCommand, isLoadingMainFrame } = fixture();
    isLoadingMainFrame.mockReturnValueOnce(true);
    sendCommand.mockRejectedValueOnce(new Error("Execution context was destroyed."));
    const pending = automation.act(
      { kind: "click", selector: ".next" },
      500,
      new AbortController().signal,
    );
    await vi.runAllTimersAsync();
    await pending;
    expect(
      sendCommand.mock.calls
        .filter(([method]) => method === "Input.dispatchMouseEvent")
        .map(([, params]) => params?.type),
    ).toEqual(["mousePressed", "mouseReleased"]);
  });

  it("allows extraction polling during navigation but does not swallow invalid selectors", async () => {
    const { automation, sendCommand, isLoadingMainFrame } = fixture();
    const signal = new AbortController().signal;
    isLoadingMainFrame.mockReturnValueOnce(true);
    expect(await automation.extract(extraction, signal)).toEqual([]);
    expect(sendCommand).not.toHaveBeenCalled();
    sendCommand.mockRejectedValueOnce(new Error("Cannot find default execution context"));
    expect(await automation.extract(extraction, signal)).toEqual([]);
    sendCommand.mockResolvedValueOnce({ result: { value: { error: "INVALID_INPUT" } } });
    await expect(automation.extract(extraction, signal)).rejects.toThrow("INVALID_INPUT");
  });

  it("prevents input if cancellation arrives during target resolution", async () => {
    const { automation, sendCommand } = fixture();
    const controller = new AbortController();
    sendCommand.mockImplementation(async () => {
      controller.abort(new AppError("CANCELLED"));
      return { result: { value: { ready: true, x: 10, y: 20 } } };
    });
    await expect(
      automation.act({ kind: "click", selector: ".next" }, 500, controller.signal),
    ).rejects.toThrow("CANCELLED");
    expect(sendCommand.mock.calls.map(([method]) => method)).toEqual(["Runtime.evaluate"]);
  });

  it("times out while the main frame never settles", async () => {
    vi.useFakeTimers();
    const { automation, sendCommand, isLoadingMainFrame } = fixture();
    isLoadingMainFrame.mockReturnValue(true);
    const pending = automation.act(
      { kind: "wait", selector: ".item" },
      100,
      new AbortController().signal,
    );
    const assertion = expect(pending).rejects.toThrow("TIMEOUT");
    await vi.runAllTimersAsync();
    await assertion;
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("snapshots list items and scopes item actions to the snapshotted element", async () => {
    const { automation, sendCommand } = fixture();
    const signal = new AbortController().signal;
    // A snapshot returns absolute paths; actOnItem must resolve its selector inside that scope.
    sendCommand.mockResolvedValueOnce({
      result: { value: { paths: ["body>article:nth-of-type(1)", "body>article:nth-of-type(2)"] } },
    });
    expect(await automation.snapshotItems(".item", signal)).toBe(2);
    await automation.actOnItem(1, { kind: "click", selector: ".detail-link" }, 500, signal);
    const scoped = sendCommand.mock.calls
      .filter(([method]) => method === "Runtime.evaluate")
      .map(([, params]) => String(params?.expression ?? ""))[1];
    expect(scoped).toContain('"body>article:nth-of-type(2)"');
    expect(scoped).toContain('".detail-link"');
  });

  it("keeps incomplete rows visible for the row policy", async () => {
    const { automation, sendCommand } = fixture();
    const signal = new AbortController().signal;
    const rows = { records: [{ name: "complete" }, { name: "" }, { name: "complete-2" }] };
    // "row" defers dropping to the host-side gate, so the incomplete record travels back.
    sendCommand.mockResolvedValueOnce({ result: { value: rows } });
    expect(await automation.extract({ ...extraction, missing: "row" }, signal)).toEqual(
      rows.records,
    );
  });

  it("rejects item actions without a matching snapshot entry", async () => {
    const { automation, sendCommand } = fixture();
    sendCommand.mockResolvedValueOnce({ result: { value: { paths: ["body>article"] } } });
    await automation.snapshotItems(".item", new AbortController().signal);
    await expect(
      automation.actOnItem(
        3,
        { kind: "click", selector: ".detail-link" },
        500,
        new AbortController().signal,
      ),
    ).rejects.toThrow("NOT_FOUND");
    // The out-of-range index must fail before any browser input is dispatched.
    expect(sendCommand.mock.calls.filter(([method]) => method === "Runtime.evaluate")).toHaveLength(
      1,
    );
  });
});
