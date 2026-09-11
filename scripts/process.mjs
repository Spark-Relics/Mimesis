import { spawn } from "node:child_process";
import { resolve } from "node:path";
import electron from "electron";

export function launchElectron(extraEnvironment = {}) {
  const env = {
    ...process.env,
    CLAWLER_DEFAULT_DATA_DIR: process.env.CLAWLER_DEFAULT_DATA_DIR ?? resolve(".cache/user-data"),
    CLAWLER_CONFIG_DIR: process.env.CLAWLER_CONFIG_DIR ?? resolve(".cache/launcher"),
    ...extraEnvironment,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return spawn(electron, [resolve("apps/desktop")], { env, stdio: "inherit", windowsHide: false });
}

export async function runCommand(command, args) {
  const child = spawn(command, args, { stdio: "inherit", windowsHide: true });
  const code = await new Promise((resolveCode, reject) => {
    child.on("error", reject);
    child.on("exit", resolveCode);
  });
  if (code !== 0) process.exit(code ?? 1);
}
