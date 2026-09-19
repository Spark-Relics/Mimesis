import { AppError } from "@clawler/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { completedRun, execution, memoryRepository, submission } from "./fixtures.test-support";
import { GatewayQueue } from "./queue";
import { GatewayServer, gatewayConfigFromEnv } from "./server";

const token = "test-token-with-at-least-thirty-two-characters";
const resources: Array<{ queue: GatewayQueue; server: GatewayServer }> = [];
afterEach(async () => {
  for (const { queue, server } of resources.splice(0)) {
    await queue.close();
    await server.close();
  }
});

async function setup() {
  const repository = memoryRepository();
  const queue = await GatewayQueue.open(repository, {
    resolve: () => execution,
    execute: async () => completedRun(),
  });
  const server = await GatewayServer.listen({ token, port: 0 }, queue, () => [execution.instance]);
  resources.push({ queue, server });
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
  const submit = (body: unknown = submission, key = "test") =>
    request("/v1/jobs", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Idempotency-Key": key },
    });
  return { request, submit, queue, server, repository };
}

describe("local HTTP gateway", () => {
  it("streams job lifecycle events over SSE until a terminal state", async () => {
    const { submit, queue } = await setup();
    const server = resources[resources.length - 1]?.server;
    const { job } = await (await submit()).json();
    const received: Array<{ status: string }> = [];
    if (!server) throw new Error("missing server");
    const stream = await fetch(`http://127.0.0.1:${server.port}/v1/jobs/${job.id}/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("Content-Type")).toContain("text/event-stream");
    queue.start();
    const body = stream.body;
    if (!server || !body) throw new Error("missing server or stream body");
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (
      received.length === 0 ||
      !["succeeded", "failed", "cancelled"].includes(received[received.length - 1]?.status ?? "")
    ) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const block of buffer.split("\n\n")) {
        const data = /^event: job\ndata: (.+)$/mu.exec(block.trim());
        if (data?.[1]) received.push(JSON.parse(data[1]) as { status: string });
      }
    }
    expect(received.map((entry) => entry.status)).toContain("succeeded");
    await reader.cancel();
  });

  it("returns the webhook delivery record alongside the job", async () => {
    const { submit, request } = await setup();
    const { job } = await (await submit()).json();
    const body = (await (await request(`/v1/jobs/${job.id}`)).json()) as {
      job: { id: string };
      delivery: unknown;
    };
    expect(body.job.id).toBe(job.id);
    // A job without a webhook has no delivery entry.
    expect(body.delivery).toBeNull();
  });

  it("redrives a failed webhook delivery over HTTP and refuses a job without one", async () => {
    const repository = memoryRepository();
    const queue = await GatewayQueue.open(
      repository,
      { resolve: () => execution, execute: async () => completedRun() },
      { fetch: (async () => new Response("no", { status: 503 })) as unknown as typeof fetch },
    );
    const server = await GatewayServer.listen({ token, port: 0 }, queue, () => [
      execution.instance,
    ]);
    resources.push({ queue, server });
    const submitJob = async (body: unknown) =>
      (
        await fetch(`http://127.0.0.1:${server.port}/v1/jobs`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      ).json();
    const retry = (id: string) =>
      fetch(`http://127.0.0.1:${server.port}/v1/jobs/${id}/delivery/retry`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    const { job } = await submitJob({
      ...submission,
      webhook: { url: "http://127.0.0.1:9/hook", maxAttempts: 1 },
    });
    queue.start();
    await vi.waitFor(() => expect(queue.delivery(job.id)?.status).toBe("failed"));
    const response = await retry(job.id);
    expect(response.status).toBe(200);
    expect((await response.json()).delivery).toMatchObject({ status: "pending", attempts: 0 });
    // A job without a webhook has nothing to redrive.
    const plain = await submitJob(submission);
    expect((await retry(plain.job.id)).status).toBe(404);
  }, 15_000);

  it("requires authentication on every route and rejects browser origins without exposing secrets", async () => {
    const { request } = await setup();
    for (const path of ["/v1/health", "/v1/jobs", "/v1/instances", "/unknown"]) {
      const response = await request(path, { headers: { Authorization: "Bearer wrong" } });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(token);
    }
    const origin = await request("/v1/health", { headers: { Origin: "https://example.com" } });
    expect(origin.status).toBe(403);
    expect(origin.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const health = await request("/v1/health");
    expect(health.status).toBe(200);
    expect(health.headers.get("Cache-Control")).toBe("no-store");
  });

  it("supports submit, query, idempotency, cancellation, pagination and three export formats", async () => {
    const { request, submit, queue } = await setup();
    expect((await (await request("/v1/instances")).json()).instances).toHaveLength(1);
    const accepted = await submit();
    expect(accepted.status).toBe(202);
    const { job } = await accepted.json();
    expect(accepted.headers.get("Location")).toBe(`/v1/jobs/${job.id}`);
    expect((await request(`/v1/jobs/${job.id}/result`)).status).toBe(409);
    expect((await submit()).status).toBe(200);
    expect((await submit({ ...submission, cleaning: { trim: false } })).status).toBe(409);
    queue.start();
    await vi.waitFor(() => expect(queue.get(job.id).status).toBe("succeeded"));
    for (const format of ["json", "csv", "ndjson"]) {
      const result = await request(`/v1/jobs/${job.id}/result?format=${format}`);
      expect(result.status).toBe(200);
      expect(result.headers.get("Content-Disposition")).toContain(`${job.id}.${format}`);
      expect(await result.text()).toContain("Catalog");
    }
    expect((await request(`/v1/jobs/${job.id}/result?format=xml`)).status).toBe(400);
    expect((await (await request("/v1/jobs?offset=1&limit=1")).json()).jobs).toEqual([]);
    expect((await request("/v1/jobs?limit=0")).status).toBe(400);
    const cancelled = await request(`/v1/jobs/${job.id}/cancel`, { method: "POST" });
    expect((await cancelled.json()).job.status).toBe("succeeded");
    expect((await request(`/v1/jobs/${crypto.randomUUID()}`)).status).toBe(404);
  });

  it("rejects malformed, oversized, unknown and unsupported request data", async () => {
    const { request, submit } = await setup();
    expect((await submit({ ...submission, source: "process.exit()" })).status).toBe(400);
    expect((await submit({ instanceId: "../../secret" })).status).toBe(400);
    expect((await request("/v1/jobs", { method: "POST", body: "{" })).status).toBe(400);
    expect(
      (
        await request("/v1/jobs", {
          method: "POST",
          body: "{}",
          headers: { "Content-Type": "text/plain" },
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await request("/v1/jobs", {
          method: "POST",
          body: JSON.stringify({ padding: "x".repeat(70_000) }),
        })
      ).status,
    ).toBe(413);
    expect((await request("/v1/jobs/invalid")).status).toBe(400);
    expect((await request("/v1/workspace")).status).toBe(404);
  });

  it("reports persistence failures as unavailable", async () => {
    const { request, submit, repository } = await setup();
    vi.mocked(repository.save).mockRejectedValueOnce(new AppError("STORAGE_FAILED"));
    expect((await submit()).status).toBe(503);
    expect((await request("/v1/health")).status).toBe(503);
  });

  it("is disabled without configuration and refuses weak or malformed configuration", () => {
    expect(gatewayConfigFromEnv({})).toBeUndefined();
    expect(gatewayConfigFromEnv({ CLAWLER_GATEWAY_TOKEN: token })).toEqual({ token, port: 17840 });
    for (const env of [
      { CLAWLER_GATEWAY_PORT: "17840" },
      { CLAWLER_GATEWAY_TOKEN: "short" },
      { CLAWLER_GATEWAY_TOKEN: token, CLAWLER_GATEWAY_PORT: "NaN" },
    ])
      expect(() => gatewayConfigFromEnv(env)).toThrow();
  });

  it("rate limits requests per second and recovers in the next window", async () => {
    const repository = memoryRepository();
    const queue = await GatewayQueue.open(repository, {
      resolve: () => execution,
      execute: async () => completedRun(),
    });
    const server = await GatewayServer.listen({ token, port: 0, rateLimit: 3 }, queue, () => [
      execution.instance,
    ]);
    resources.push({ queue, server });
    const request = (path: string) =>
      fetch(`http://127.0.0.1:${server.port}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    for (let index = 0; index < 3; index += 1)
      expect((await request("/v1/health")).status).toBe(200);
    const limited = await request("/v1/health");
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.code).toBe("RATE_LIMITED");
    const retryAfter = Number(limited.headers.get("Retry-After"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000 + 50));
    expect((await request("/v1/health")).status).toBe(200);
  }, 15_000);

  it("parses the optional rate limit environment variable and rejects malformed values", () => {
    expect(
      gatewayConfigFromEnv({ CLAWLER_GATEWAY_TOKEN: token, CLAWLER_GATEWAY_RATE_LIMIT: "50" }),
    ).toEqual({
      token,
      port: 17840,
      rateLimit: 50,
    });
    expect(
      gatewayConfigFromEnv({ CLAWLER_GATEWAY_TOKEN: token, CLAWLER_GATEWAY_RATE_LIMIT: "0" }),
    ).toEqual({
      token,
      port: 17840,
      rateLimit: 0,
    });
    expect(() =>
      gatewayConfigFromEnv({ CLAWLER_GATEWAY_TOKEN: token, CLAWLER_GATEWAY_RATE_LIMIT: "NaN" }),
    ).toThrow();
    expect(() =>
      gatewayConfigFromEnv({ CLAWLER_GATEWAY_TOKEN: token, CLAWLER_GATEWAY_RATE_LIMIT: "-1" }),
    ).toThrow();
  });

  it("parses the optional concurrency environment variable and rejects malformed values", () => {
    expect(
      gatewayConfigFromEnv({ CLAWLER_GATEWAY_TOKEN: token, CLAWLER_GATEWAY_CONCURRENCY: "4" }),
    ).toEqual({ token, port: 17840, concurrency: 4 });
    expect(() =>
      gatewayConfigFromEnv({ CLAWLER_GATEWAY_TOKEN: token, CLAWLER_GATEWAY_CONCURRENCY: "0" }),
    ).toThrow();
    expect(() =>
      gatewayConfigFromEnv({ CLAWLER_GATEWAY_TOKEN: token, CLAWLER_GATEWAY_CONCURRENCY: "NaN" }),
    ).toThrow();
    expect(() =>
      gatewayConfigFromEnv({ CLAWLER_GATEWAY_TOKEN: token, CLAWLER_GATEWAY_CONCURRENCY: "9" }),
    ).toThrow();
  });

  it("parses the optional job timeout environment variable and rejects malformed values", () => {
    expect(
      gatewayConfigFromEnv({
        CLAWLER_GATEWAY_TOKEN: token,
        CLAWLER_GATEWAY_JOB_TIMEOUT_MS: "60000",
      }),
    ).toEqual({ token, port: 17840, jobTimeoutMs: 60000 });
    expect(() =>
      gatewayConfigFromEnv({
        CLAWLER_GATEWAY_TOKEN: token,
        CLAWLER_GATEWAY_JOB_TIMEOUT_MS: "-1",
      }),
    ).toThrow();
    expect(() =>
      gatewayConfigFromEnv({
        CLAWLER_GATEWAY_TOKEN: token,
        CLAWLER_GATEWAY_JOB_TIMEOUT_MS: "NaN",
      }),
    ).toThrow();
    expect(() =>
      gatewayConfigFromEnv({
        CLAWLER_GATEWAY_TOKEN: token,
        CLAWLER_GATEWAY_JOB_TIMEOUT_MS: "86400001",
      }),
    ).toThrow();
  });

  it("accepts the previous token during rotation and rejects others", async () => {
    expect(
      gatewayConfigFromEnv({
        CLAWLER_GATEWAY_TOKEN: token,
        CLAWLER_GATEWAY_PREVIOUS_TOKEN: "previous-token-with-at-least-32-characters",
      }),
    ).toEqual({
      token,
      port: 17840,
      previousToken: "previous-token-with-at-least-32-characters",
    });
    expect(() =>
      gatewayConfigFromEnv({
        CLAWLER_GATEWAY_TOKEN: token,
        CLAWLER_GATEWAY_PREVIOUS_TOKEN: "short",
      }),
    ).toThrow();
    const repository = memoryRepository();
    const queue = await GatewayQueue.open(repository, {
      resolve: () => execution,
      execute: async () => completedRun(),
    });
    const server = await GatewayServer.listen(
      { token, port: 0, previousToken: "previous-token-with-at-least-32-characters" },
      queue,
      () => [execution.instance],
    );
    resources.push({ queue, server });
    const request = (authorization: string) =>
      fetch(`http://127.0.0.1:${server.port}/v1/health`, {
        headers: { Authorization: authorization },
      });
    expect((await request(`Bearer ${token}`)).status).toBe(200);
    expect((await request("Bearer previous-token-with-at-least-32-characters")).status).toBe(200);
    expect((await request("Bearer another-token-with-at-least-32-characters-x")).status).toBe(401);
  });

  it("grants a read-only credential reads of every safe route and rejects mutations", async () => {
    const readOnlyToken = "read-only-token-with-at-least-32-characters";
    expect(
      gatewayConfigFromEnv({
        CLAWLER_GATEWAY_TOKEN: token,
        CLAWLER_GATEWAY_READONLY_TOKEN: readOnlyToken,
      }),
    ).toEqual({
      token,
      port: 17840,
      readOnlyToken,
    });
    expect(() =>
      gatewayConfigFromEnv({
        CLAWLER_GATEWAY_TOKEN: token,
        CLAWLER_GATEWAY_READONLY_TOKEN: "short",
      }),
    ).toThrow();
    const repository = memoryRepository();
    const queue = await GatewayQueue.open(repository, {
      resolve: () => execution,
      execute: async () => completedRun(),
    });
    const server = await GatewayServer.listen({ token, port: 0, readOnlyToken }, queue, () => [
      execution.instance,
    ]);
    resources.push({ queue, server });
    const request = (path: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${server.port}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${readOnlyToken}`,
          "Content-Type": "application/json",
          ...init.headers,
        },
      });
    const { job } = await (
      await fetch(`http://127.0.0.1:${server.port}/v1/jobs`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(submission),
      })
    ).json();
    // Every GET route stays reachable with the read-only credential.
    for (const path of ["/v1/health", "/v1/instances", "/v1/jobs", `/v1/jobs/${job.id}`]) {
      expect((await request(path)).status).toBe(200);
    }
    // Mutations are refused before touching the queue.
    const submit = await request("/v1/jobs", {
      method: "POST",
      body: JSON.stringify(submission),
    });
    expect(submit.status).toBe(403);
    expect((await submit.json()).error.code).toBe("FORBIDDEN");
    const cancel = await request(`/v1/jobs/${job.id}/cancel`, { method: "POST" });
    expect(cancel.status).toBe(403);
    // The write token is unaffected and can still mutate.
    const writeCancel = await fetch(`http://127.0.0.1:${server.port}/v1/jobs/${job.id}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(writeCancel.status).toBe(200);
  });
});
