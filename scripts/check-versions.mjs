import { readdir, readFile } from "node:fs/promises";

const manifests = ["package.json"];
for (const root of ["apps", "packages"]) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) manifests.push(`${root}/${entry.name}/package.json`);
  }
}
const versions = new Map();
for (const file of manifests) {
  const manifest = JSON.parse(await readFile(file, "utf8"));
  for (const [name, version] of Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  })) {
    if (!name.startsWith("@clawler/")) versions.set(name, version);
  }
}
const results = await Promise.allSettled(
  [...versions].map(async ([name, pinned]) => {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`);
    if (!response.ok) throw new Error(`${name}: registry returned ${response.status}`);
    const latest = await response.json();
    return { name, pinned, latest: latest.version, current: pinned === latest.version };
  }),
);
for (const result of results) {
  if (result.status === "rejected") {
    console.error(result.reason);
    process.exitCode = 1;
    continue;
  }
  console.log(JSON.stringify(result.value));
  if (!result.value.current) process.exitCode = 1;
}
