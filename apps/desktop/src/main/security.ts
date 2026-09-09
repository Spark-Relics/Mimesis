import { resolve, sep } from "node:path";
import { AppError } from "@clawler/contracts";
import type { IpcMainInvokeEvent } from "electron";

export function assertTrustedSender(
  event: IpcMainInvokeEvent,
  windowId: number,
  devUrl?: string,
): void {
  if (event.sender.id !== windowId || event.senderFrame !== event.sender.mainFrame)
    throw new AppError("FORBIDDEN");
  const url = new URL(event.senderFrame.url);
  if (devUrl && url.origin === new URL(devUrl).origin) return;
  if (!devUrl && url.protocol === "clawler-app:" && url.hostname === "ui") return;
  throw new AppError("FORBIDDEN");
}

export function resolveAssetPath(root: string, pathname: string): string {
  const decoded = decodeURIComponent(pathname);
  if (decoded.includes("\\") || decoded.includes("\0")) throw new AppError("FORBIDDEN");
  let relative = decoded.replace(/^\/+/, "");
  if (!relative) relative = "index.html";
  const target = resolve(root, relative);
  if (!target.startsWith(`${resolve(root)}${sep}`)) throw new AppError("FORBIDDEN");
  return target;
}
