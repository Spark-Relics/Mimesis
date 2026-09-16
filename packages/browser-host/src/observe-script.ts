import type { PageStructure } from "@clawler/contracts";

/**
 * Deterministic page analysis: finds repeated sibling structures (list rows),
 * stable selectors for their inner fields, and next-page controls. No model is
 * involved — structural repetition plus candidate stability, so the user
 * confirms a proposal instead of writing CSS selectors by hand.
 *
 * Serialized into the page context via `Runtime.evaluate`, so it must stay
 * self-contained: no module-scope identifiers, no imports.
 */
export function observeStructure(): { error?: string } | PageStructure {
  type Field = {
    name: string;
    selector: string;
    attribute: "text" | "href" | "src" | "value";
    samples: string[];
  };
  type List = { selector: string; itemSelector: string; count: number; fields: Field[] };

  const volatile = /active|selected|hover|focus|disabled|open|show|hide|loading|placeholder/iu;
  const MAX_LISTS = 10;
  const MAX_FIELDS = 20;
  const MAX_DEPTH = 4;

  const isStable = (selector: string): boolean => {
    try {
      return document.querySelectorAll(selector).length > 0;
    } catch {
      return false;
    }
  };
  const partOf = (node: Element): string => {
    const tag = node.tagName.toLowerCase();
    if (node.id) return `#${CSS.escape(node.id)}`;
    const classes = [...node.classList].filter((value) => !volatile.test(value));
    if (classes.length) return `${tag}.${classes.map((value) => CSS.escape(value)).join(".")}`;
    return tag;
  };
  const describe = (node: Element): string => {
    const parts: string[] = [];
    let current: Element | null = node;
    while (current && current !== document.documentElement && parts.length < MAX_DEPTH) {
      parts.unshift(partOf(current));
      current = current.parentElement;
    }
    return parts.join(" > ");
  };
  /** Selector for `node` relative to `scope`, or "" when it is the scope itself. */
  const relativeTo = (scope: Element, node: Element): string => {
    const parts: string[] = [];
    let current: Element | null = node;
    while (current && current !== scope) {
      parts.unshift(partOf(current));
      current = current.parentElement;
    }
    // current === scope means the node is a descendant; otherwise the walk left the tree.
    if (current === scope) return parts.join(" > ");
    return "";
  };
  const attributeOf = (node: Element): "href" | "src" | "value" | "text" => {
    if (node instanceof HTMLAnchorElement && node.hasAttribute("href")) return "href";
    if (node instanceof HTMLImageElement && node.hasAttribute("src")) return "src";
    if (
      (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) &&
      !/password|secret|token|otp/iu.test(`${node.name} ${node.id} ${node.autocomplete}`)
    )
      return "value";
    return "text";
  };
  const text = (node: Element): string =>
    (node.textContent ?? "").replace(/\s+/gu, " ").trim().slice(0, 200);
  /** Turns a class name into a field name; returns "" when nothing usable exists. */
  const nameFromClass = (node: Element): string => {
    for (const value of node.classList) {
      const cleaned = value.replace(/[^a-zA-Z0-9]/gu, "");
      if (cleaned.length >= 3 && !volatile.test(value))
        return cleaned.slice(0, 1).toLowerCase() + cleaned.slice(1, 64);
    }
    return "";
  };
  const nameFromHeading = (node: Element): string => {
    const heading = node.querySelector("h1,h2,h3,h4,dt,strong,b");
    let label = text(node);
    if (heading) label = text(heading);
    if (!label) return "";
    const cleaned = label.replace(/[^a-zA-Z0-9 ]/gu, "").trim();
    if (!cleaned) return "";
    return cleaned
      .split(/\s+/gu)
      .slice(0, 3)
      .map((word, at) => {
        // The first word keeps its initial; the rest are truncated harder.
        if (at === 0) return word.slice(0, 1).toLowerCase();
        return word.slice(0, 8).toLowerCase();
      })
      .join("");
  };

  /** Collects non-overlapping repeated structures under one container. */
  const lists: List[] = [];
  const containers = document.querySelectorAll(
    "ul,ol,tbody,table,div,section,main,article,aside,nav",
  );
  for (const container of containers) {
    if (lists.length >= MAX_LISTS) break;
    // Group children by their structural signature; a real list repeats siblings.
    const groups = new Map<string, Element[]>();
    for (const child of container.children) {
      const signature = partOf(child);
      const group = groups.get(signature) ?? [];
      group.push(child);
      groups.set(signature, group);
    }
    for (const group of groups.values()) {
      if (group.length < 3 || lists.length >= MAX_LISTS) continue;
      // Heuristic field discovery: leaf-like descendants with text, links or images.
      const first = group[0] as Element;
      const seen = new Set<string>();
      const fields: Field[] = [];
      const leafSelector = "a[href],img,h1,h2,h3,h4,p,span,td,li,strong,em,input,textarea";
      first.querySelectorAll(leafSelector).forEach((node) => {
        // Wrappers that only contain other candidates are skipped: leaves carry the data.
        if (node.querySelector(leafSelector)) return;
        if (fields.length >= MAX_FIELDS) return;
        // The field selector is relative to the item itself.
        const selector = relativeTo(first, node);
        if (seen.has(selector)) return;
        if (selector && !isStable(selector)) return;
        seen.add(selector);
        const attribute = attributeOf(node);
        const samples = group.slice(0, 3).map((row) => {
          let target: Element | null = row;
          if (selector) target = row.querySelector(selector);
          if (!target) return "";
          if (attribute === "text") return text(target);
          if (attribute === "value" && target instanceof HTMLInputElement) return target.value;
          return target.getAttribute(attribute) ?? "";
        });
        if (!samples.some(Boolean)) return;
        const name = nameFromClass(node) || nameFromHeading(node) || `field${fields.length + 1}`;
        fields.push({ name, selector, attribute, samples });
      });
      const containerSelector = describe(container);
      if (!isStable(containerSelector)) continue;
      // Rows are the repeated children themselves; workflows collect one record per row.
      const itemSelector = `${containerSelector} > ${partOf(first)}`;
      lists.push({ selector: containerSelector, itemSelector, count: group.length, fields });
    }
  }
  // Drop lists whose selector is a shallower duplicate of another (same area).
  const deduped = lists.filter(
    (entry) =>
      !lists.some(
        (other) =>
          other.selector !== entry.selector && other.selector.startsWith(`${entry.selector} > `),
      ),
  );
  const scored = deduped
    .slice()
    .sort((left, right) => right.fields.length - left.fields.length || right.count - left.count);

  const pagination: Array<{ selector: string; label: string }> = [];
  const seenLabels = new Set<string>();
  document.querySelectorAll("a,button,[role='button']").forEach((node) => {
    if (pagination.length >= 5) return;
    const label = text(node).toLowerCase();
    if (!label) return;
    // Next-page affordances are conventional; wording covers the common cases.
    if (!/(next|more|older|load|下一页|更多|加载|后一页)/iu.test(label)) return;
    const selector = describe(node);
    if (!isStable(selector) || seenLabels.has(selector)) return;
    seenLabels.add(selector);
    pagination.push({ selector, label: label.slice(0, 100) });
  });

  return { url: location.href, lists: scored.slice(0, MAX_LISTS), pagination };
}

/**
 * Outlines the elements a selector would collect, so the user sees the match
 * before committing it to the workflow. An empty selector clears all markers.
 *
 * Serialized into the page context; must stay self-contained.
 */
export function highlightElements(selector: string): { count: number } {
  const marker = "clawler-highlight";
  document.querySelectorAll(`[data-${marker}]`).forEach((node) => {
    node.removeAttribute(`data-${marker}`);
  });
  if (!selector.trim()) return { count: 0 };
  let matches: NodeListOf<Element>;
  try {
    matches = document.querySelectorAll(selector);
  } catch {
    return { count: 0 };
  }
  matches.forEach((node) => {
    node.setAttribute(`data-${marker}`, "");
  });
  return { count: matches.length };
}
