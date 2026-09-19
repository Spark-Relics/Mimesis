import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AppError, type AutomationInstance, toErrorCode, z } from "@clawler/contracts";
import { GatewayError, type GatewayQueue } from "./queue";
import { cleanResult, resultContentTypes, serializeResult } from "./results";

const credential = z.string().regex(/^[\x21-\x7e]{32,256}$/u);
const configSchema = z.object({
  token: credential,
  port: z.number().int().min(0).max(65535),
  rateLimit: z.number().int().min(0).max(10_000).optional(),
  concurrency: z.number().int().min(1).max(8).optional(),
  jobTimeoutMs: z.number().int().min(0).max(86_400_000).optional(),
  previousToken: credential.optional(),
  readOnlyToken: credential.optional(),
});
export type GatewayConfig = z.infer<typeof configSchema>;

export function gatewayConfigFromEnv(env: NodeJS.ProcessEnv): GatewayConfig | undefined {
  if (env.CLAWLER_GATEWAY_TOKEN === undefined && env.CLAWLER_GATEWAY_PORT === undefined)
    return undefined;
  const rateLimit = env.CLAWLER_GATEWAY_RATE_LIMIT;
  let parsedRateLimit: number | undefined;
  if (rateLimit !== undefined) parsedRateLimit = Number(rateLimit);
  const concurrency = env.CLAWLER_GATEWAY_CONCURRENCY;
  let parsedConcurrency: number | undefined;
  if (concurrency !== undefined) parsedConcurrency = Number(concurrency);
  const jobTimeoutMs = env.CLAWLER_GATEWAY_JOB_TIMEOUT_MS;
  let parsedJobTimeoutMs: number | undefined;
  if (jobTimeoutMs !== undefined) parsedJobTimeoutMs = Number(jobTimeoutMs);
  const previousToken = env.CLAWLER_GATEWAY_PREVIOUS_TOKEN;
  const readOnlyToken = env.CLAWLER_GATEWAY_READONLY_TOKEN;
  return configSchema.parse({
    token: env.CLAWLER_GATEWAY_TOKEN,
    port: Number(env.CLAWLER_GATEWAY_PORT ?? "17840"),
    rateLimit: parsedRateLimit,
    concurrency: parsedConcurrency,
    jobTimeoutMs: parsedJobTimeoutMs,
    previousToken,
    readOnlyToken,
  });
}

/** Fixed-window request limiter. Zero/undefined capacity means unlimited. */
class RateLimiter {
  private windowStart = 0;
  private count = 0;

  constructor(
    private readonly limitPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns retry-after milliseconds when the request exceeds the window budget. */
  take(): number | undefined {
    if (this.limitPerSecond <= 0) return undefined;
    const current = this.now();
    if (current - this.windowStart >= 1000) {
      this.windowStart = current;
      this.count = 0;
    }
    this.count += 1;
    if (this.count <= this.limitPerSecond) return undefined;
    return Math.max(1, this.windowStart + 1000 - current);
  }
}

/** Digests a bearer credential for constant-time comparison; undefined stays undefined. */
function digestOf(token: string | undefined): Buffer | undefined {
  if (token === undefined) return undefined;
  return createHash("sha256").update(`Bearer ${token}`).digest();
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
    const limiter = new RateLimiter(config.rateLimit ?? 0);
    const expected = digestOf(config.token) as Buffer;
    const previous = digestOf(config.previousToken);
    const readOnly = digestOf(config.readOnlyToken);
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
          const retryAfterMs = limiter.take();
          if (retryAfterMs !== undefined) {
            response.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
            throw new HttpError(429, "RATE_LIMITED");
          }
          if (request.headers.origin !== undefined) throw new HttpError(403, "FORBIDDEN");
          const actual = createHash("sha256")
            .update(request.headers.authorization ?? "")
            .digest();
          // A credential either grants read+write (token / rotation) or read only.
          // Reading is any safe method; everything that mutates jobs requires write.
          const canWrite =
            timingSafeEqual(actual, expected) ||
            (previous !== undefined && timingSafeEqual(actual, previous));
          const canRead = readOnly !== undefined && timingSafeEqual(actual, readOnly);
          if (!canWrite && !canRead) {
            response.setHeader("WWW-Authenticate", "Bearer");
            throw new HttpError(401, "UNAUTHORIZED");
          }
          if (!canWrite && request.method !== "GET") throw new HttpError(403, "FORBIDDEN");
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
              const body = await readJson(request);
              let submissionInput: unknown = body;
              let webhook: unknown = null;
              if (body !== null && typeof body === "object" && "webhook" in body) {
                // The submission schema is strict: strip the transport-only key.
                const { webhook: extracted, ...rest } = body as { webhook: unknown } & Record<
                  string,
                  unknown
                >;
                webhook = extracted;
                submissionInput = rest;
              }
              const result = await queue.submit(submissionInput, key ?? null, webhook);
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
          const redeliverMatch = /^\/v1\/jobs\/([^/]+)\/delivery\/retry$/u.exec(url.pathname);
          if (redeliverMatch && request.method === "POST") {
            const id = z.string().uuid().parse(redeliverMatch[1]);
            json(response, 200, { delivery: await queue.redeliver(id) });
            return;
          }
          const match = /^\/v1\/jobs\/([^/]+)(?:\/(cancel|result|events))?$/u.exec(url.pathname);
          if (match) {
            const id = z.string().uuid().parse(match[1]);
            const action = match[2];
            if (request.method === "POST" && action === "cancel") {
              json(response, 200, { job: await queue.cancel(id) });
              return;
            }
            if (request.method === "GET" && action === "events") {
              queue.get(id);
              response.writeHead(200, {
                "Content-Type": "text/event-stream; charset=utf-8",
                Connection: "keep-alive",
              });
              const send = (job: { status: string }) => {
                if (response.destroyed || response.writableEnded) return;
                response.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
                if (
                  job.status === "succeeded" ||
                  job.status === "failed" ||
                  job.status === "cancelled"
                ) {
                  unsubscribe();
                  response.end();
                }
              };
              const unsubscribe = queue.subscribe(id, send);
              request.on("close", () => {
                unsubscribe();
              });
              return;
            }
            if (request.method === "GET" && !action) {
              // The outbox record travels with the job so a caller can observe
              // delivery outcome (pending/delivered/failed) without polling twice.
              json(response, 200, { job: queue.get(id), delivery: queue.delivery(id) });
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
