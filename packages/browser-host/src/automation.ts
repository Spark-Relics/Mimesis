import {
  AppError,
  type CollectionRecord,
  collectionRecordsSchema,
  type Extraction,
  extractionSchema,
  type WorkflowAction,
  workflowActionSchema,
  z,
} from "@clawler/contracts";
import type { BrowserAutomationPort } from "@clawler/script-sdk";
import type { WebContents } from "electron";

function locate(
  selector: string,
  prepare: boolean,
  fill: boolean,
  unique: boolean,
  scopeSelector?: string,
) {
  try {
    let root: ParentNode = document;
    if (scopeSelector) {
      const scope = document.querySelectorAll(scopeSelector);
      if (scope.length !== 1) return { error: "INVALID_INPUT" };
      const element = scope[0];
      if (!(element instanceof HTMLElement)) return { ready: false };
      root = element;
    }
    const matches = root.querySelectorAll(selector);
    if (unique && matches.length > 1) return { error: "INVALID_INPUT" };
    const node = matches[0];
    if (!(node instanceof HTMLElement)) return { ready: false };
    const disabled =
      node.matches(":disabled") || node.closest('[aria-disabled="true"], .disabled') !== null;
    if (disabled) return { ready: false };
    if (prepare) node.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    if (!box.width || !box.height || style.visibility === "hidden" || style.display === "none")
      return { ready: false };
    const x = Math.max(0, Math.min(innerWidth - 1, box.x + box.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, box.y + box.height / 2));
    const hit = document.elementFromPoint(x, y);
    if (prepare && (!hit || !node.contains(hit))) return { ready: false };
    if (fill) {
      if (
        !(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) ||
        node.readOnly
      )
        return { error: "INVALID_INPUT" };
      if (
        node instanceof HTMLInputElement &&
        !["text", "search", "email", "url", "tel"].includes(node.type)
      )
        return { error: "FORBIDDEN" };
      node.focus();
      node.select();
    }
    return { ready: true, x, y };
  } catch {
    return { error: "INVALID_INPUT" };
  }
}

function extractPage(input: Extraction) {
  try {
    const items = document.querySelectorAll(input.items);
    if (items.length > 2000) return { error: "INVALID_INPUT" };
    const records: Array<Record<string, string>> = [];
    for (const item of items) {
      const pairs: Array<[string, string]> = [];
      for (const field of input.fields) {
        let node: Element | null = item;
        if (field.selector) node = item.querySelector(field.selector);
        let value = "";
        if (node) {
          if (field.attribute === "text") value = node.textContent ?? "";
          else if (field.attribute === "value") {
            if (node instanceof HTMLInputElement && node.type === "password")
              return { error: "FORBIDDEN" };
            if (
              node instanceof HTMLInputElement ||
              node instanceof HTMLTextAreaElement ||
              node instanceof HTMLSelectElement
            )
              value = node.value;
          } else {
            value = node.getAttribute(field.attribute) ?? "";
            if (value) value = new URL(value, document.baseURI).href;
          }
        }
        value = value.trim();
        if (value.length > 16_000) return { error: "INVALID_INPUT" };
        // A row may be present before an asynchronous field has loaded.
        if (field.required && !value) {
          // "page" keeps the historical semantics: one bad row voids the whole page
          // so polling can retry once the field loads. "row" defers the decision:
          // the incomplete record travels back and the host-side gate drops it.
          if (input.missing === "row") break;
          return { records: [] };
        }
        pairs.push([field.name, value]);
      }
      records.push(Object.fromEntries(pairs));
    }
    return { records };
  } catch {
    return { error: "INVALID_INPUT" };
  }
}

/** Absolute `:nth-child` path, unique within the document, used to re-address a list item later. */
/**
 * Serialized into the page context, so it must not reference module scope:
 * `itemPath` is deliberately inlined. A free identifier would throw inside the
 * page and surface as a generic INVALID_INPUT.
 */
function snapshotItemPaths(itemsSelector: string) {
  const itemPath = (node: Element): string => {
    const segments: string[] = [];
    let current: Element | null = node;
    while (current) {
      let index = 1;
      let sibling = current.previousElementSibling;
      while (sibling) {
        index++;
        sibling = sibling.previousElementSibling;
      }
      segments.unshift(`${current.tagName.toLowerCase()}:nth-child(${index})`);
      current = current.parentElement;
    }
    return segments.join(">");
  };
  try {
    const items = Array.from(document.querySelectorAll(itemsSelector));
    if (items.length > 2000) return { error: "INVALID_INPUT" };
    const paths = items.map(itemPath);
    for (const path of paths) {
      // Re-addressable only if the generated path resolves to exactly this element.
      if (!path || document.querySelectorAll(path).length !== 1) return { error: "INVALID_INPUT" };
    }
    return { paths };
  } catch {
    return { error: "INVALID_INPUT" };
  }
}

export async function pause(signal: AbortSignal, milliseconds = 100): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export class BrowserAutomation implements BrowserAutomationPort {
  constructor(private readonly contents: () => WebContents) {}
  /** Absolute paths of the list items recorded by the most recent `snapshotItems` call. */
  private itemSelectors: string[] = [];

  private async evaluate(
    contents: WebContents,
    expression: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    const raw: unknown = await contents.debugger.sendCommand("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    signal.throwIfAborted();
    const response = z
      .object({
        result: z.object({ value: z.unknown().optional() }),
        exceptionDetails: z.unknown().optional(),
      })
      .parse(raw);
    if (response.exceptionDetails) throw new AppError("INVALID_INPUT");
    const error = z
      .object({ error: z.enum(["INVALID_INPUT", "FORBIDDEN"]) })
      .safeParse(response.result.value);
    if (error.success) throw new AppError(error.data.error);
    return response.result.value;
  }

  private isNavigationError(error: unknown): boolean {
    return (
      error instanceof Error &&
      /execution context (was destroyed|is not available)|cannot find (default )?execution context|cannot find context with specified id|inspected target navigated/iu.test(
        error.message,
      )
    );
  }

  private async runAction(
    action: WorkflowAction,
    timeoutMs: number,
    signal: AbortSignal,
    scopeSelector?: string,
  ): Promise<void> {
    // Only element actions reach the page; HTTP requests go through the HttpPort instead.
    if (action.kind === "request") throw new AppError("INVALID_INPUT");
    const contents = this.contents();
    const deadline = Date.now() + timeoutMs;
    while (true) {
      signal.throwIfAborted();
      let state: { ready: boolean; x?: number | undefined; y?: number | undefined } = {
        ready: false,
      };
      if (!contents.isLoadingMainFrame()) {
        try {
          state = z
            .object({ ready: z.boolean(), x: z.number().optional(), y: z.number().optional() })
            .parse(
              await this.evaluate(
                contents,
                `(${locate.toString()})(${JSON.stringify(action.selector)},${action.kind !== "wait"},${action.kind === "fill"},${action.kind !== "wait"},${JSON.stringify(scopeSelector)})`,
                signal,
              ),
            );
        } catch (error) {
          signal.throwIfAborted();
          if (!this.isNavigationError(error)) throw error;
        }
      }
      if (state.ready) {
        signal.throwIfAborted();
        if (action.kind === "fill")
          await contents.debugger.sendCommand("Input.insertText", { text: action.value });
        if (action.kind === "click") {
          const position = { x: state.x, y: state.y, button: "left", clickCount: 1 };
          await contents.debugger.sendCommand("Input.dispatchMouseEvent", {
            ...position,
            type: "mousePressed",
          });
          await contents.debugger.sendCommand("Input.dispatchMouseEvent", {
            ...position,
            type: "mouseReleased",
          });
        }
        signal.throwIfAborted();
        return;
      }
      if (Date.now() >= deadline) throw new AppError("TIMEOUT");
      await pause(signal);
    }
  }

  act(input: WorkflowAction, timeoutMs: number, signal: AbortSignal): Promise<void> {
    return this.runAction(workflowActionSchema.parse(input), timeoutMs, signal);
  }

  async actOnItem(
    index: number,
    input: WorkflowAction,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const action = workflowActionSchema.parse(input);
    const scopeSelector = this.itemSelectors[index];
    if (scopeSelector === undefined) throw new AppError("NOT_FOUND");
    await this.runAction(action, timeoutMs, signal, scopeSelector);
  }

  async snapshotItems(itemsSelector: string, signal: AbortSignal): Promise<number> {
    const selector = z.string().trim().min(1).max(2048).parse(itemsSelector);
    const contents = this.contents();
    signal.throwIfAborted();
    if (contents.isLoadingMainFrame()) return 0;
    try {
      const value = await this.evaluate(
        contents,
        `(${snapshotItemPaths.toString()})(${JSON.stringify(selector)})`,
        signal,
      );
      const paths = z.object({ paths: z.array(z.string()).max(2000) }).parse(value).paths;
      this.itemSelectors = paths;
      return paths.length;
    } catch (error) {
      signal.throwIfAborted();
      if (this.isNavigationError(error)) return 0;
      throw error;
    }
  }

  async extract(input: Extraction, signal: AbortSignal): Promise<CollectionRecord[]> {
    const extraction = extractionSchema.parse(input);
    const contents = this.contents();
    signal.throwIfAborted();
    if (contents.isLoadingMainFrame()) return [];
    try {
      const value = await this.evaluate(
        contents,
        `(${extractPage.toString()})(${JSON.stringify(extraction)})`,
        signal,
      );
      return z.object({ records: collectionRecordsSchema }).parse(value).records;
    } catch (error) {
      signal.throwIfAborted();
      if (this.isNavigationError(error)) return [];
      throw error;
    }
  }

  async exists(selector: string, signal: AbortSignal): Promise<boolean> {
    const result = await this.evaluate(
      this.contents(),
      `(${locate.toString()})(${JSON.stringify(selector)},false,false,true)`,
      signal,
    );
    return z.object({ ready: z.boolean() }).parse(result).ready;
  }
}
