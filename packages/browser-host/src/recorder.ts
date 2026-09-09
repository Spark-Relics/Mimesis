import { AppError, type Recording, workflowActionSchema, z } from "@clawler/contracts";
import type { WebContents } from "electron";

function installRecorder(binding: string) {
  if (window.top !== window) return;
  const stopKey = `${binding}_stop`;
  const previousStop = Reflect.get(globalThis, stopKey);
  if (typeof previousStop === "function") previousStop();
  const emit = (action: unknown) => {
    const target = Reflect.get(globalThis, binding);
    if (typeof target === "function") target(JSON.stringify(action));
  };
  const selector = (node: Element): string => {
    const parts: string[] = [];
    let current: Element | null = node;
    while (current && parts.length < 8) {
      let part = current.tagName.toLowerCase();
      if (current.id) part = `#${CSS.escape(current.id)}`;
      else {
        const classes = [...current.classList]
          .filter((value) => !/active|selected|hover|focus/iu.test(value))
          .slice(0, 2);
        if (classes.length) part += classes.map((value) => `.${CSS.escape(value)}`).join("");
        else if (current.parentElement) {
          const siblings = [...current.parentElement.children].filter(
            (entry) => entry.tagName === current?.tagName,
          );
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
      }
      parts.unshift(part);
      const joined = parts.join(" > ");
      if (document.querySelectorAll(joined).length === 1) return joined;
      current = current.parentElement;
    }
    return parts.join(" > ");
  };
  const input = (event: Event) => {
    if (!event.isTrusted) return;
    const node = event.target;
    if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) return;
    if (
      node instanceof HTMLInputElement &&
      !["text", "search", "email", "url", "tel"].includes(node.type)
    ) {
      emit({ kind: "skipped" });
      return;
    }
    if (
      /password|secret|token|otp|verification|credit.?card|one-time-code|cc-number|cc-csc|cc-exp/iu.test(
        `${node.name} ${node.id} ${node.autocomplete}`,
      )
    ) {
      emit({ kind: "skipped" });
      return;
    }
    emit({ kind: "fill", selector: selector(node), value: node.value });
  };
  const click = (event: MouseEvent) => {
    if (!event.isTrusted || event.button !== 0 || !(event.target instanceof Element)) return;
    const node = event.target.closest(
      'a,button,[role="button"],input[type="submit"],input[type="button"]',
    );
    if (node) emit({ kind: "click", selector: selector(node) });
  };
  document.addEventListener("input", input, true);
  document.addEventListener("click", click, true);
  Reflect.set(globalThis, stopKey, () => {
    document.removeEventListener("input", input, true);
    document.removeEventListener("click", click, true);
    Reflect.deleteProperty(globalThis, stopKey);
  });
}

interface RecordingSession {
  contents: WebContents;
  binding: string;
  scriptId: string;
  value: Recording;
  listener: (event: Electron.Event, method: string, params: Record<string, unknown>) => void;
  setup: Promise<void>;
  cleanup?: Promise<void>;
}

export class BrowserRecorder {
  private recording: RecordingSession | undefined;
  private stopping: Promise<Recording> | undefined;
  get active() {
    return this.recording !== undefined || this.stopping !== undefined;
  }

  async start(contents: WebContents): Promise<void> {
    if (this.recording || this.stopping) throw new AppError("BUSY");
    const url = contents.getURL();
    if (!/^https?:/u.test(url)) throw new AppError("INVALID_INPUT");
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    const binding = `mimesis_${crypto.randomUUID().replaceAll("-", "")}`;
    const value: Recording = { url, actions: [], skipped: 0 };
    const listener = (_event: Electron.Event, method: string, params: Record<string, unknown>) => {
      if (this.recording !== current) return;
      if (
        method !== "Runtime.bindingCalled" ||
        params.name !== binding ||
        typeof params.payload !== "string" ||
        params.payload.length > 16_384
      )
        return;
      try {
        const input: unknown = JSON.parse(params.payload);
        const action = workflowActionSchema.safeParse(input);
        if (!action.success) {
          value.skipped++;
          return;
        }
        const previous = value.actions.at(-1);
        if (
          previous?.kind === "fill" &&
          action.data.kind === "fill" &&
          previous.selector === action.data.selector
        ) {
          previous.value = action.data.value;
          return;
        }
        if (value.actions.length >= 20) {
          value.skipped++;
          return;
        }
        value.actions.push(action.data);
      } catch {
        value.skipped++;
      }
    };
    const current: RecordingSession = {
      contents,
      binding,
      scriptId: "",
      value,
      listener,
      setup: Promise.resolve(),
    };
    this.recording = current;
    contents.debugger.on("message", listener);
    current.setup = this.install(current);
    try {
      await current.setup;
      if (this.recording !== current) throw new AppError("CANCELLED");
    } catch (error) {
      if (this.recording === current) this.recording = undefined;
      await this.cleanup(current);
      throw error;
    }
  }

  private async install(current: RecordingSession): Promise<void> {
    const { contents, binding } = current;
    await contents.debugger.sendCommand("Runtime.enable");
    await contents.debugger.sendCommand("Page.enable");
    await contents.debugger.sendCommand("Runtime.addBinding", {
      name: binding,
      executionContextName: binding,
    });
    const source = `(${installRecorder.toString()})(${JSON.stringify(binding)})`;
    const script = z.object({ identifier: z.string() }).parse(
      await contents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
        source,
        worldName: binding,
      }),
    );
    current.scriptId = script.identifier;
    const contextId = await this.context(current);
    const result = z
      .object({ exceptionDetails: z.unknown().optional() })
      .parse(
        await contents.debugger.sendCommand("Runtime.evaluate", { expression: source, contextId }),
      );
    if (result.exceptionDetails) throw new AppError("INTERNAL");
  }

  private async context({ contents, binding }: RecordingSession): Promise<number> {
    const tree = z
      .object({ frameTree: z.object({ frame: z.object({ id: z.string() }) }) })
      .parse(await contents.debugger.sendCommand("Page.getFrameTree"));
    const context = z.object({ executionContextId: z.number() }).parse(
      await contents.debugger.sendCommand("Page.createIsolatedWorld", {
        frameId: tree.frameTree.frame.id,
        worldName: binding,
      }),
    );
    return context.executionContextId;
  }

  private cleanup(current: RecordingSession): Promise<void> {
    if (!current.cleanup) current.cleanup = this.remove(current);
    return current.cleanup;
  }

  private async remove(current: RecordingSession): Promise<void> {
    const { contents, listener, binding, scriptId } = current;
    contents.debugger.removeListener("message", listener);
    if (contents.isDestroyed() || !contents.debugger.isAttached()) return;
    // Remove future installation first, then disconnect and clean the live document.
    if (scriptId)
      await contents.debugger
        .sendCommand("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId })
        .catch(() => undefined);
    await contents.debugger
      .sendCommand("Runtime.removeBinding", { name: binding })
      .catch(() => undefined);
    try {
      const contextId = await this.context(current);
      await contents.debugger.sendCommand("Runtime.evaluate", {
        expression: `globalThis[${JSON.stringify(`${binding}_stop`)}]?.()`,
        contextId,
      });
    } catch {
      /* The document may have navigated or closed during cleanup. */
    }
  }

  async stop(): Promise<Recording> {
    const current = this.recording;
    if (!current && this.stopping) return this.stopping;
    if (!current) throw new AppError("NOT_FOUND");
    this.recording = undefined;
    const stopping = current.setup
      .catch(() => undefined)
      .then(async () => {
        await this.cleanup(current);
        return structuredClone(current.value);
      });
    this.stopping = stopping;
    try {
      return await stopping;
    } finally {
      if (this.stopping === stopping) this.stopping = undefined;
    }
  }
}
