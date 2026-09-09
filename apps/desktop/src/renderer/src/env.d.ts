import type { DesktopBridge } from "@clawler/contracts";

declare global {
  interface Window {
    clawler?: DesktopBridge;
  }
}
