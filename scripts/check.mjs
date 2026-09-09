import { runCommand } from "./process.mjs";

for (const script of ["typecheck", "lint", "test", "build"]) {
  const packageManager = process.env.npm_execpath;
  if (!packageManager) throw new Error("Run this check through pnpm.");
  if (packageManager.endsWith(".exe")) await runCommand(packageManager, ["run", script]);
  else await runCommand(process.execPath, [packageManager, "run", script]);
}
