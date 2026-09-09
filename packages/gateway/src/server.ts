import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AppError, type AutomationInstance, toErrorCode, z } from "@clawler/contracts";
import { GatewayError, type GatewayQueue } from "./queue";
import { cleanResult, resultContentTypes, serializeResult } from "./results";

const configSchema = z.object({
  token: z.string().regex(/^[\x21-\x7e]{32,256}$/u),
  port: z.number().int().min(0).max(65535),
});
export type GatewayConfig = z.infer<typeof configSchema>;

export function gatewayConfigFromEnv(env: NodeJS.ProcessEnv): GatewayConfig | undefined {
  if (env.CLAWLER_GATEWAY_TOKEN === undefined && env.CLAWLER_GATEWAY_PORT === undefined)
    return undefined;
  return configSchema.parse({
    token: env.CLAWLER_GATEWAY_TOKEN,
    port: Number(env.CLAWLER_GATEWAY_PORT ?? "17840"),
  });
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

const statusCodes: Record<string, number> = {
  INVALID_INPUT: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  BUSY: 409,
  CONFLICT: 409,
  RESULT_NOT_READY: 409,
  QUEUE_FULL: 429,
  UNAVAILABLE: 503,
  STORAGE_FAILED: 503,
};

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (
    request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
    request.headers["content-encoding"]
  )
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += Buffer.byteLength(chunk);
    if (size > 65_536) throw new HttpError(413, "PAYLOAD_TOO_LARGE");
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("INVALID_INPUT");
  }
}

function integerParameter(url: URL, key: string, fallback: number, max: number): number {
  const value = url.searchParams.get(key);
  if (value === null) return fallback;
  if (!/^\d+$/u.test(value)) throw new AppError("INVALID_INPUT");
  return z.number().int().min(0).max(max).parse(Number(value));
}

export class GatewayServer {
  private constructor(
    private readonly server: Server,
    public readonly port: number,
  ) {}

  static async listen(
    input: GatewayConfig,
    queue: GatewayQueue,
    listInstances: () => AutomationInstance[],
  ): Promise<GatewayServer> {
    const config = configSchema.parse(input);
    const expected = createHash("sha256").update(`Bearer ${config.token}`).digest();
    const server = createServer(
      {
        maxHeaderSize: 16_384,
        requestTimeout: 15_000,
        headersTimeout: 10_000,
        keepAliveTimeout: 5000,
      },
      (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        void (async () => {
          if (request.headers.origin !== undefined) throw new HttpError(403, "FORBIDDEN");
          const actual = createHash("sha256")
            .update(request.headers.authorization ?? "")
            .digest();
          if (!timingSafeEqual(actual, expected)) {
            response.setHeader("WWW-Authenticate", "Bearer");
            throw new HttpError(401, "UNAUTHORIZED");
          }
          const url = new URL(request.url ?? "/", "http://127.0.0.1");
          if (request.method === "GET" && url.pathname === "/v1/health") {
            const health = queue.health();
            let status = 200;
            if (!health.ready) status = 503;
            json(response, status, health);
            return;
          }
          if (request.method === "GET" && url.pathname === "/v1/instances") {
            json(response, 200, { instances: listInstances() });
            return;
          }
          if (url.pathname === "/v1/jobs") {
            if (request.method === "POST") {
              const key = request.headers["idempotency-key"];
              if (Array.isArray(key)) throw new AppError("INVALID_INPUT");
              const result = await queue.submit(await readJson(request), key ?? null);
              response.setHeader("Location", `/v1/jobs/${result.job.id}`);
              let status = 202;
              if (result.replayed) status = 200;
              json(response, status, result);
              return;
            }
            if (request.method === "GET") {
              const offset = integerParameter(url, "offset", 0, 1_000_000);
              const limit = integerParameter(url, "limit", 50, 100);
              if (limit < 1) throw new AppError("INVALID_INPUT");
              json(response, 200, queue.list(offset, limit));
              return;
            }
          }
          const match = /^\/v1\/jobs\/([^/]+)(?:\/(cancel|result))?$/u.exec(url.pathname);
          if (match) {
            const id = z.string().uuid().parse(match[1]);
            const action = match[2];
            if (request.method === "POST" && action === "cancel") {
              json(response, 200, { job: await queue.cancel(id) });
              return;
            }
            if (request.method === "GET" && !action) {
              json(response, 200, { job: queue.get(id) });
              return;
            }
            if (request.method === "GET" && action === "result") {
              const format = z
                .enum(["json", "csv", "ndjson"])
                .parse(url.searchParams.get("format") ?? "json");
              const job = queue.get(id);
              if (job.status !== "succeeded" || !job.run?.result)
                throw new GatewayError("RESULT_NOT_READY");
              response.writeHead(200, {
                "Content-Type": resultContentTypes[format],
                "Content-Disposition": `attachment; filename="${id}.${format}"`,
              });
              response.end(
                serializeResult(cleanResult(job.run.result, job.submission.cleaning), format),
              );
              return;
            }
          }
          throw new HttpError(404, "NOT_FOUND");
        })().catch((error: unknown) => {
          if (response.destroyed || response.writableEnded) return;
          const code = toErrorCode(error);
          let status = statusCodes[code] ?? 500;
          let publicCode: string = code;
          if (error instanceof HttpError) {
            status = error.status;
            publicCode = error.code;
          }
          if (error instanceof GatewayError) {
            publicCode = error.code;
            status = statusCodes[publicCode] ?? 500;
          }
          response.setHeader("Connection", "close");
          if (status === 429) response.setHeader("Retry-After", "5");
          json(response, status, { error: { code: publicCode } });
        });
      },
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new AppError("INTERNAL");
    return new GatewayServer(server, address.port);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
      this.server.closeAllConnections();
    });
  }
}
