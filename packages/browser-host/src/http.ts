import { AppError } from "@clawler/contracts";
import type { HttpPort } from "@clawler/script-sdk";
import { net } from "electron";

/** Privileged HTTP adapter: scripts describe requests, only the host performs them. */
export class HttpHost implements HttpPort {
  /** Resolves the active browser profile session; absent means requests stay isolated. */
  constructor(private readonly sessionProvider?: () => Electron.Session | undefined) {}

  async fetch(
    request: {
      method: string;
      url: string;
      headers: Record<string, string>;
      body?: string;
      useSession?: boolean;
    },
    timeoutMs: number,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<{ status: number; body: string }> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      throw new AppError("INVALID_INPUT");
    }
    if (url.username || url.password) throw new AppError("INVALID_INPUT");
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new AppError("FORBIDDEN");
    signal.throwIfAborted();
    // Session-linked requests reuse profile cookies/storage for authenticated APIs.
    // `useSessionCookies` is required: passing a session alone does not attach its cookies.
    let session: Electron.Session | undefined;
    if (request.useSession === true) session = this.sessionProvider?.();
    const client = net.request({
      method: request.method,
      url: url.href,
      ...(session && { session, useSessionCookies: true }),
      ...(Object.keys(request.headers).length && { headers: request.headers }),
    });
    const timer = setTimeout(() => {
      client.abort();
    }, timeoutMs);
    const abort = () => client.abort();
    signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await new Promise<{ status: number; chunks: Buffer[] }>(
        (resolve, reject) => {
          client.on("response", (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on("data", (chunk: Buffer) => {
              chunks.push(chunk);
              // Reject as soon as the declared cap is exceeded, before buffering more.
              if (Buffer.concat(chunks).length > maxBytes) {
                client.abort();
                reject(new AppError("INVALID_INPUT"));
              }
            });
            incoming.on("end", () => resolve({ status: incoming.statusCode, chunks }));
            incoming.on("error", (error) => reject(error));
          });
          client.on("error", (error) => reject(error));
          if (request.body !== undefined) client.write(request.body);
          client.end();
        },
      );
      signal.throwIfAborted();
      return { status: response.status, body: Buffer.concat(response.chunks).toString("utf8") };
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof AppError) throw error;
      // Aborted by timeout or network failure: distinguish the two callers care about.
      if (error instanceof Error && error.message === "Aborted") throw new AppError("TIMEOUT");
      throw new AppError("REQUEST_FAILED");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
}
