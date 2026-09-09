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
});
