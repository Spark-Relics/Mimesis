import type { CollectionWorkflow, WorkflowVersion } from "@clawler/contracts";
import { describe, expect, it } from "vitest";
import {
  bindingOf,
  buildVersion,
  exportVersionFile,
  importVersionFile,
  nextVersionNumber,
  parameterNames,
  validateForPublish,
  verifyVersion,
  workflowDigest,
} from "./versions";

const recipe: CollectionWorkflow = {
  version: 1,
  before: [
    { kind: "fill", selector: "#search", value: "{{query}}" },
    { kind: "click", selector: "#submit" },
    { kind: "fill", selector: "#page", value: "{{query}}-{{size}}" },
  ],
  extract: {
    items: ".item",
    fields: [{ name: "name", selector: ".name", attribute: "text", required: true }],
  },
  pagination: { next: ".next", maxPages: 3 },
  waitTimeoutMs: 300,
  maxRecords: 10,
  dedupe: [],
};

function version(overrides: Partial<WorkflowVersion> = {}): WorkflowVersion {
  return {
    id: crypto.randomUUID(),
    instanceId: crypto.randomUUID(),
    version: 1,
    digest: workflowDigest("https://example.com/", recipe),
    targetUrl: "https://example.com/",
    workflow: recipe,
    note: "",
    publishedAt: "2026-09-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("parameterNames", () => {
  it("reports placeholders in first-use order without duplicates", () => {
    expect(parameterNames(recipe)).toEqual(["query", "size"]);
    // `{{page}}` is the pagination cursor, never a run parameter.
    const templated: CollectionWorkflow = {
      ...recipe,
      before: [{ kind: "fill", selector: "#search", value: "{{query}}" }],
      pagination: {
        urlTemplate: "https://example.com?q={{query}}&p={{page}}",
        startPage: 1,
        maxPages: 3,
      },
    };
    expect(parameterNames(templated)).toEqual(["query"]);
  });

  it("rejects a placeholder that cannot be a parameter name", () => {
    const invalid: CollectionWorkflow = {
      ...recipe,
      before: [{ kind: "fill", selector: "#search", value: "{{1bad}}" }],
    };
    expect(() => parameterNames(invalid)).toThrow("INVALID_INPUT");
  });
});

describe("validateForPublish", () => {
  it("rejects an unclosed marker that would be sent to the page literally", () => {
    const broken = { ...recipe, before: [{ kind: "fill", selector: "#a", value: "{{query" }] };
    expect(() => validateForPublish(broken)).toThrow("INVALID_INPUT");
  });

  it("rejects a pagination limit that cannot page", () => {
    const single = { ...recipe, pagination: { next: ".next", maxPages: 1 } };
    expect(() => validateForPublish(single)).toThrow("INVALID_INPUT");
  });
});

describe("workflowDigest", () => {
  it("is independent of object key order", () => {
    const reordered: CollectionWorkflow = {
      maxRecords: recipe.maxRecords,
      waitTimeoutMs: recipe.waitTimeoutMs,
      pagination: { maxPages: 3, next: ".next" },
      extract: {
        fields: [{ required: true, attribute: "text", selector: ".name", name: "name" }],
        items: ".item",
      },
      before: [
        { value: "{{query}}", selector: "#search", kind: "fill" },
        { selector: "#submit", kind: "click" },
        { value: "{{query}}-{{size}}", selector: "#page", kind: "fill" },
      ],
      version: 1,
      dedupe: [],
    };
    expect(workflowDigest("https://example.com/", reordered)).toBe(
      workflowDigest("https://example.com/", recipe),
    );
  });

  it("changes with the target address and with workflow content", () => {
    const base = workflowDigest("https://example.com/", recipe);
    expect(workflowDigest("https://example.com/other", recipe)).not.toBe(base);
    const changed = { ...recipe, maxRecords: 11 };
    expect(workflowDigest("https://example.com/", changed)).not.toBe(base);
  });
});

describe("version export/import", () => {
  it("round-trips a version through a portable file", () => {
    const original = version({ note: "export me" });
    const file = exportVersionFile(original, "2026-09-15T00:00:00.000Z");
    const imported = importVersionFile(file, {
      instanceId: crypto.randomUUID(),
      existing: [],
      publishedAt: "2026-09-15T00:01:00.000Z",
    });
    expect(imported.version).toBe(1);
    expect(imported.targetUrl).toBe(original.targetUrl);
    expect(imported.digest).toBe(original.digest);
    expect(imported.workflow).toEqual(original.workflow);
    expect(imported.note).toBe("export me");
    expect(verifyVersion(imported)).toBe(true);
  });

  it("numbers an import after existing versions", () => {
    const original = version();
    const first = buildVersion({
      instanceId: "00000000-0000-4000-8000-000000000001",
      targetUrl: "https://example.com/",
      workflow: recipe,
      note: "",
      publishedAt: "2026-09-15T00:00:00.000Z",
      existing: [],
    });
    const imported = importVersionFile(exportVersionFile(original, "2026-09-15T00:00:00.000Z"), {
      instanceId: first.instanceId,
      existing: [first],
      publishedAt: "2026-09-15T00:02:00.000Z",
    });
    expect(imported.instanceId).toBe(first.instanceId);
    expect(imported.version).toBe(2);
  });

  it("refuses a tampered digest", () => {
    const file = exportVersionFile(version(), "2026-09-15T00:00:00.000Z");
    const parsed = JSON.parse(file) as { workflow: CollectionWorkflow };
    parsed.workflow = { ...parsed.workflow, maxRecords: 999 };
    expect(() =>
      importVersionFile(JSON.stringify(parsed), {
        instanceId: crypto.randomUUID(),
        existing: [],
        publishedAt: "2026-09-15T00:00:00.000Z",
      }),
    ).toThrow("VERSION_CONFLICT");
  });

  it("refuses malformed files and refuses to export a corrupted version", () => {
    expect(() =>
      importVersionFile("not json", {
        instanceId: crypto.randomUUID(),
        existing: [],
        publishedAt: "2026-09-15T00:00:00.000Z",
      }),
    ).toThrow("INVALID_INPUT");
    expect(() =>
      exportVersionFile(version({ digest: "0".repeat(64) }), "2026-09-15T00:00:00.000Z"),
    ).toThrow("VERSION_CONFLICT");
  });
});

describe("buildVersion", () => {
  it("numbers versions per instance and stays verifiable", () => {
    const instanceId = crypto.randomUUID();
    const first = buildVersion({
      instanceId,
      targetUrl: "https://example.com/",
      workflow: recipe,
      note: "first",
      publishedAt: "2026-09-14T00:00:00.000Z",
      existing: [],
    });
    const second = buildVersion({
      instanceId,
      targetUrl: "https://example.com/",
      workflow: { ...recipe, maxRecords: 11 },
      note: "second",
      publishedAt: "2026-09-14T00:01:00.000Z",
      existing: [first],
    });
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(nextVersionNumber([])).toBe(1);
    expect(verifyVersion(first)).toBe(true);
    expect(bindingOf(first)).toEqual({
      versionId: first.id,
      version: 1,
      digest: first.digest,
      targetUrl: first.targetUrl,
      workflow: first.workflow,
    });
  });
});

describe("verifyVersion", () => {
  it("detects edited content and edited addresses", () => {
    const stored = version();
    expect(verifyVersion(stored)).toBe(true);
    expect(verifyVersion({ ...stored, targetUrl: "https://example.com/other" })).toBe(false);
    expect(verifyVersion({ ...stored, workflow: { ...recipe, maxRecords: 11 } })).toBe(false);
  });

  it("refuses to bind content that no longer matches its digest", () => {
    const tampered = { ...version(), workflow: { ...recipe, maxRecords: 11 } };
    expect(() => bindingOf(tampered)).toThrow("VERSION_CONFLICT");
  });
});
