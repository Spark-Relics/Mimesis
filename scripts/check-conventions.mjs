import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "@babel/parser";

const errors = [];
async function files(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", "dist"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await files(path)));
    else if (/\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type === "string") visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (!["loc", "comments", "tokens"].includes(key)) walk(value, visit);
  }
}

for (const file of [...(await files("apps")), ...(await files("packages"))]) {
  const source = await readFile(file, "utf8");
  const plugins = ["typescript"];
  if (file.endsWith(".tsx")) plugins.push("jsx");
  const ast = parse(source, { sourceType: "module", plugins });
  const portable = file.replaceAll("\\", "/");
  const report = (node, message) => errors.push(`${portable}:${node.loc?.start.line}: ${message}`);
  walk(ast, (node) => {
    if (node.type === "ConditionalExpression")
      report(
        node,
        "Ternary expressions are prohibited; use named maps, helpers or explicit branches.",
      );
    if (node.type === "JSXText" && node.value.trim())
      report(node, "Application UI copy must use the shared typed translation API.");
    if (
      node.type === "JSXAttribute" &&
      ["title", "placeholder", "aria-label", "alt"].includes(node.name.name) &&
      node.value?.type === "StringLiteral" &&
      node.value.value
    ) {
      report(node, "Translate user-facing attributes with useI18n().");
    }
    if (node.type !== "ImportDeclaration") return;
    const imported = node.source.value;
    if (!portable.startsWith("packages/i18n/") && ["i18next", "react-i18next"].includes(imported))
      report(node, "Import @clawler/i18n instead of bypassing the internationalization wrapper.");
    if (
      portable.includes("src/renderer/") &&
      (imported === "electron" ||
        imported.startsWith("node:") ||
        ["@clawler/browser-host", "@clawler/storage", "@clawler/workflow-core"].includes(imported))
    )
      report(node, "Renderer modules must use the typed preload bridge, not privileged packages.");
    if (
      portable.startsWith("packages/workflow-core/") &&
      ["electron", "react", "i18next"].includes(imported)
    )
      report(node, "Workflow core must remain independent from Electron and UI frameworks.");
  });
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else console.log("Architecture and i18n conventions passed: no ternaries or inline JSX copy.");
