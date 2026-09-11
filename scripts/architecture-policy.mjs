/** Explicit package boundaries. Add a module only with an architecture decision. */
export const workspaceDependencies = {
  "@clawler/contracts": [],
  "@clawler/script-sdk": ["@clawler/contracts"],
  "@clawler/script-registry": ["@clawler/contracts", "@clawler/script-sdk"],
  "@clawler/workflow-core": ["@clawler/contracts", "@clawler/script-sdk"],
  "@clawler/browser-host": ["@clawler/contracts", "@clawler/script-sdk"],
  "@clawler/storage": ["@clawler/contracts"],
  "@clawler/gateway": ["@clawler/contracts", "@clawler/storage"],
  "@clawler/i18n": [],
  "@clawler/ui": [],
};

export function dependencyErrors(packages) {
  const errors = [];
  const graph = new Map(
    packages.map((entry) => [
      entry.name,
      Object.keys(entry.dependencies ?? {}).filter((name) => name.startsWith("@clawler/")),
    ]),
  );
  for (const entry of packages) {
    const allowed = workspaceDependencies[entry.name];
    if (!allowed) {
      errors.push(`${entry.name}: missing architecture policy`);
      continue;
    }
    for (const dependency of graph.get(entry.name) ?? []) {
      if (!allowed.includes(dependency))
        errors.push(`${entry.name}: forbidden dependency ${dependency}`);
      if (!graph.has(dependency))
        errors.push(`${entry.name}: unknown workspace dependency ${dependency}`);
    }
  }
  const visited = new Set();
  function visit(name, path) {
    if (path.includes(name)) {
      errors.push(`Dependency cycle: ${[...path, name].join(" → ")}`);
      return;
    }
    if (visited.has(name)) return;
    for (const dependency of graph.get(name) ?? []) visit(dependency, [...path, name]);
    visited.add(name);
  }
  for (const name of graph.keys()) visit(name, []);
  return errors;
}

export function importError(owner, specifier, manifest, bundled = false) {
  if (!specifier.startsWith("@clawler/")) return undefined;
  const name = specifier.split("/").slice(0, 2).join("/");
  if (name === owner) return undefined;
  const declared = { ...manifest.dependencies };
  // Desktop dependencies are fully bundled and intentionally live in devDependencies.
  if (bundled) Object.assign(declared, manifest.devDependencies);
  if (!Object.hasOwn(declared, name)) return `Undeclared workspace dependency ${name}`;
  return undefined;
}
