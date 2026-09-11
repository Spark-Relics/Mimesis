import { resolve } from "node:path";
import { AppError, DEMO_URL, requestSchema, validateNavigationUrl } from "@clawler/contracts";
import { describe, expect, it } from "vitest";
import { resolveAssetPath } from "../../apps/desktop/src/main/security";

describe("browser and IPC boundaries", () => {
  it("accepts only intended browser protocols", () => {
    expect(validateNavigationUrl("https://example.com")).toBe("https://example.com/");
    expect(validateNavigationUrl(DEMO_URL)).toBe(DEMO_URL);
    for (const url of [
      "javascript:alert(1)",
      "file:///C:/Windows/win.ini",
      "data:text/html,x",
      "clawler-app://ui/",
      "clawler-demo://other/",
      "https://user:secret@example.com/",
    ]) {
      expect(() => validateNavigationUrl(url)).toThrow(AppError);
    }
  });
  it("rejects malformed command data and unknown commands", () => {
    expect(requestSchema.safeParse({ method: "draft.save", source: "unused" }).success).toBe(false);
    expect(requestSchema.safeParse({ method: "shell.exec", command: "whoami" }).success).toBe(
      false,
    );
    expect(requestSchema.safeParse({ method: "profiles.select", id: "../../x" }).success).toBe(
      false,
    );
    expect(
      requestSchema.safeParse({
        method: "browser.bounds",
        bounds: { x: -1, y: 0, width: 500, height: 500, visible: true },
      }).success,
    ).toBe(false);
  });
  it("confines local app assets to the renderer output", () => {
    const root = resolve("example-assets");
    expect(resolveAssetPath(root, "/assets/app.js")).toBe(resolve(root, "assets/app.js"));
    expect(() => resolveAssetPath(root, "/%2e%2e/secret")).toThrow(AppError);
    expect(() => resolveAssetPath(root, "/..\\secret")).toThrow(AppError);
    expect(() => resolveAssetPath(root, "/%00secret")).toThrow(AppError);
  });
});
