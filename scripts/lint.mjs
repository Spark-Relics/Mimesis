import { runCommand } from "./process.mjs";

await runCommand(process.execPath, ["node_modules/@biomejs/biome/bin/biome", "check", "."]);
await runCommand(process.execPath, ["scripts/check-conventions.mjs"]);
