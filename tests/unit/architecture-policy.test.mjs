import { expect, it } from "vitest";
import { dependencyErrors, importError } from "../../scripts/architecture-policy.mjs";

const contracts = { name: "@clawler/contracts", dependencies: {} };
const sdk = { name: "@clawler/script-sdk", dependencies: { "@clawler/contracts": "workspace:*" } };

it("accepts the core's declared dependency direction", () => {
  expect(dependencyErrors([contracts, sdk])).toEqual([]);
});

it("rejects dependency cycles and inward infrastructure imports", () => {
  const errors = dependencyErrors([
    { ...contracts, dependencies: { "@clawler/script-sdk": "workspace:*" } },
    sdk,
  ]);
  expect(errors.some((error) => error.includes("forbidden dependency"))).toBe(true);
  expect(errors.some((error) => error.includes("Dependency cycle"))).toBe(true);
});

it("requires explicit policy for new modules and declared public imports", () => {
  expect(dependencyErrors([{ name: "@clawler/new-module" }])[0]).toContain(
    "missing architecture policy",
  );
  expect(importError(sdk.name, "@clawler/storage/atomic-file", sdk)).toContain("Undeclared");
  expect(importError(sdk.name, "@clawler/contracts", sdk)).toBeUndefined();
});

it("allows build-time dependencies only for a bundled app", () => {
  const manifest = { devDependencies: { "@clawler/storage": "workspace:*" } };
  expect(
    importError("@clawler/desktop", "@clawler/storage/atomic-file", manifest, true),
  ).toBeUndefined();
  expect(importError("@clawler/gateway", "@clawler/storage/atomic-file", manifest)).toContain(
    "Undeclared",
  );
});
