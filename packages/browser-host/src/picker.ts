import { AppError, z } from "@clawler/contracts";
import type { WebContents } from "electron";

/**
 * Injected into the page like the recorder: this function is serialized, so it
 * must stay self-contained (no imports, no closures over module state). The
 * selector algorithm intentionally mirrors the recorder's — both build the
 * shortest unique CSS path for the clicked element.
 */
function installPicker(binding: string) {
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
  let outlined: Element | null = null;
  const clearOutline = () => {
    if (outlined) outlined.removeAttribute("data-clawler-highlight");
    outlined = null;
  };
  const over = (event: MouseEvent) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    clearOutline();
    outlined = event.target;
    // Reuses the highlight style BrowserHost already injects into every page.
    outlined.setAttribute("data-clawler-highlight", "");
  };
  const click = (event: MouseEvent) => {
    if (!event.isTrusted || event.button !== 0 || !(event.target instanceof Element)) return;
    // Keep the user on the page: the pick is a selection, not navigation.
    event.preventDefault();
    event.stopPropagation();
    const picked = selector(event.target);
    clearOutline();
    emit({ selector: picked });
    stop();
  };
  const stop = () => {
    clearOutline();
    document.removeEventListener("mouseover", over, true);
    document.removeEventListener("click", click, true);
    Reflect.deleteProperty(globalThis, stopKey);
  };
  document.addEventListener("mouseover", over, true);
  document.addEventListener("click", click, true);
  Reflect.set(globalThis, stopKey, stop);
}

const pickedSchema = z.object({ selector: z.string().min(1).max(2048) });

interface PickSession {
  contents: WebContents;
  binding: string;
  scriptId: string;
  listener: (event: Electron.Event, method: string, params: Record<string, unknown>) => void;
  setup: Promise<void>;
  cleanup?: Promise<void>;
  settle: (selector: string) => void;
  reject: (error: AppError) => void;
}

/**
 * One-shot element picker: hovering outlines the element (same marker the
 * suggestion panel uses), clicking resolves with its CSS selector. Unlike the
 * recorder it captures any element, not just links and buttons.
 */
export class ElementPicker {
  private session: PickSession | undefined;
  get active() {
    return this.session !== undefined;
  }

  async begin(contents: WebContents): Promise<void> {
    if (this.session) throw new AppError("BUSY");
    const url = contents.getURL();
    if (!/^https?:/u.test(url)) throw new AppError("INVALID_INPUT");
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    const binding = `mimesis_${crypto.randomUUID().replaceAll("-", "")}`;
    let settled = false;
    const current = {} as PickSession;
    current.contents = contents;
    current.binding = binding;
    current.scriptId = "";
    current.listener = (
      _event: Electron.Event,
      method: string,
      params: Record<string, unknown>,
    ) => {
      if (this.session !== current) return;
      if (
        method !== "Runtime.bindingCalled" ||
        params.name !== binding ||
        typeof params.payload !== "string" ||
        params.payload.length > 4096
      )
        return;
      try {
        const picked = pickedSchema.parse(JSON.parse(params.payload));
        if (settled) return;
        settled = true;
        this.finish();
        current.settle(picked.selector);
      } catch {
        /* A malformed payload keeps waiting for the next click. */
      }
    };
    current.setup = Promise.resolve();
    const picked = new Promise<string>((resolve, reject) => {
      current.settle = resolve;
      current.reject = reject;
    });
    this.picked = picked;
    this.session = current;
    contents.debugger.on("message", current.listener);
    current.setup = this.install(current);
    try {
      await current.setup;
      if (this.session !== current) throw new AppError("CANCELLED");
    } catch (error) {
      if (this.session === current) this.finish();
      await this.cleanup(current);
      throw error;
    }
  }

  private picked: Promise<string> | undefined;

  /** Resolves with the clicked element's selector; rejects on cancel. */
  result(): Promise<string> {
    if (!this.picked) throw new AppError("NOT_FOUND");
    return this.picked;
  }

  async cancel(): Promise<void> {
    const current = this.session;
    if (!current) return;
    this.finish();
    await current.setup.catch(() => undefined);
    await this.cleanup(current);
    current.reject(new AppError("CANCELLED"));
  }

  private finish() {
    this.session = undefined;
    this.picked = undefined;
  }

  private async install(current: PickSession): Promise<void> {
    const { contents, binding } = current;
    await contents.debugger.sendCommand("Runtime.enable");
    await contents.debugger.sendCommand("Page.enable");
    await contents.debugger.sendCommand("Runtime.addBinding", {
      name: binding,
      executionContextName: binding,
    });
    const source = `(${installPicker.toString()})(${JSON.stringify(binding)})`;
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

  private async context({ contents, binding }: PickSession): Promise<number> {
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

  private cleanup(current: PickSession): Promise<void> {
    if (!current.cleanup) current.cleanup = this.remove(current);
    return current.cleanup;
  }

  private async remove(current: PickSession): Promise<void> {
    const { contents, listener, binding, scriptId } = current;
    contents.debugger.removeListener("message", listener);
    if (contents.isDestroyed() || !contents.debugger.isAttached()) return;
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
}
